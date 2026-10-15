import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Everything TubePilot saves lives in ~/.tubepilot (or TUBEPILOT_HOME if set).
export const HOME_DIR = process.env.TUBEPILOT_HOME || path.join(os.homedir(), ".tubepilot");
export const CLIENT_FILE = path.join(HOME_DIR, "client_secret.json");
export const TOKEN_FILE = path.join(HOME_DIR, "token.json");
export const QUOTA_FILE = path.join(HOME_DIR, "quota.json");

export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export function ensureHome() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJson(file: string, data: unknown) {
  ensureHome();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}
