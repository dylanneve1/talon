#!/usr/bin/env node
/**
 * MCP server entry point — Telegram tools for the Claude Agent SDK.
 * Registers shared tools (bot + userbot) and optionally userbot-only tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSharedTools } from "./shared.js";
import { registerUserbotTools } from "./userbot.js";

const FRONTEND_MODE = process.env.TALON_FRONTEND_MODE || "bot";

const server = new McpServer({ name: "telegram-tools", version: "3.0.0" });

// Always register shared tools (work with both bot and userbot)
registerSharedTools(server);

// Register userbot-only tools when running as userbot or dual mode
if (FRONTEND_MODE === "userbot" || FRONTEND_MODE === "dual") {
  registerUserbotTools(server);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
