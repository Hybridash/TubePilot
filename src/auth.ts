import http from "node:http";
import fs from "node:fs";
import { exec } from "node:child_process";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { CLIENT_FILE, TOKEN_FILE, SCOPES, readJson, writeJson, ensureHome } from "./config.js";

type ClientFile = {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
};

function loadClientInfo() {
  const raw = readJson<ClientFile>(CLIENT_FILE);
  const info = raw?.installed || raw?.web;
  if (!info) {
    throw new Error(
      `No Google login key found. Run "tubepilot setup <path to the JSON you downloaded>" first.`
    );
  }
  return info;
}

/** Copies the downloaded OAuth JSON into ~/.tubepilot so the user can delete the original. */
export function installClientFile(source: string) {
  const data = JSON.parse(fs.readFileSync(source, "utf8")) as ClientFile;
  if (!data.installed && !data.web) {
    throw new Error("That file doesn't look like a Google OAuth client JSON.");
  }
  writeJson(CLIENT_FILE, data);
}

/** Returns a ready-to-use client, or throws if the user hasn't logged in yet. */
export function getAuthClient(): OAuth2Client {
  const info = loadClientInfo();
  const client = new google.auth.OAuth2(info.client_id, info.client_secret);
  const token = readJson<Record<string, unknown>>(TOKEN_FILE);
  if (!token) {
    throw new Error(`Not logged in to YouTube yet. Run "tubepilot login" in a terminal.`);
  }
  client.setCredentials(token);
  // Save refreshed tokens so the login keeps working.
  client.on("tokens", (t) => writeJson(TOKEN_FILE, { ...token, ...t }));
  return client;
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

/** Opens Google's login page and catches the result on a local port. */
export async function login(): Promise<void> {
  ensureHome();
  const info = loadClientInfo();

  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}`;

  const client = new google.auth.OAuth2(info.client_id, info.client_secret, redirect);
  const url = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });

  console.log("\nOpening Google login in your browser...");
  console.log("If it doesn't open, paste this link into your browser:\n\n" + url + "\n");
  openBrowser(url);

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const params = new URL(req.url || "/", redirect).searchParams;
      const c = params.get("code");
      const err = params.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      if (c) {
        res.end("<h2>TubePilot is logged in. You can close this tab.</h2>");
        resolve(c);
      } else {
        res.end("<h2>Login failed: " + (err || "no code") + "</h2>");
        reject(new Error(err || "Login failed"));
      }
    });
  });
  server.close();

  const { tokens } = await client.getToken(code);
  writeJson(TOKEN_FILE, tokens);
  console.log("Logged in! TubePilot can now manage your channel.");
}
