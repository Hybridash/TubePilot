#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { installClientFile, login } from "./auth.js";
import { HOME_DIR } from "./config.js";

const [cmd, arg] = process.argv.slice(2);

async function main() {
  if (cmd === "setup") {
    if (!arg) {
      console.log('Usage: tubepilot setup "C:\\path\\to\\client_secret_xxx.json"');
      process.exit(1);
    }
    installClientFile(arg);
    console.log(`Saved your Google login key to ${HOME_DIR}. Now logging in...`);
    await login();
    return;
  }
  if (cmd === "login") {
    await login();
    return;
  }

  // Default: run as an MCP server over stdio.
  const server = new McpServer({ name: "tubepilot", version: "0.1.0" });
  registerTools(server);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
