#!/usr/bin/env node
/**
 * Unified MCP server — replaces per-backend tools.ts files.
 *
 * Reads TALON_FRONTEND env var to compose the right tool set,
 * then registers them all on a single MCP server over stdio.
 *
 * Environment:
 *   TALON_BRIDGE_URL  — HTTP bridge URL (default: http://127.0.0.1:19876)
 *   TALON_CHAT_ID     — Current chat ID
 *   TALON_FRONTEND    — Frontend type: "telegram" | "teams" | "terminal" (default: "telegram")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { composeTools } from "./index.js";
import { createBridge, textResult } from "./bridge.js";
import type { ToolFrontend } from "./types.js";

const VALID_FRONTENDS = new Set<ToolFrontend>([
  "telegram",
  "teams",
  "terminal",
]);
const BRIDGE_URL = process.env.TALON_BRIDGE_URL || "http://127.0.0.1:19876";
const CHAT_ID = process.env.TALON_CHAT_ID || "";
const rawFrontend = (process.env.TALON_FRONTEND || "telegram") as ToolFrontend;

if (!VALID_FRONTENDS.has(rawFrontend)) {
  console.error(
    `Invalid TALON_FRONTEND: "${rawFrontend}". Must be one of: ${[...VALID_FRONTENDS].join(", ")}`,
  );
  process.exit(1);
}
const FRONTEND = rawFrontend;

const bridge = createBridge(BRIDGE_URL, CHAT_ID);
const serverName = `${FRONTEND}-tools`;
const server = new McpServer({ name: serverName, version: "3.0.0" });

// Compose and register all tools for the active frontend
const tools = composeTools({ frontend: FRONTEND });

for (const tool of tools) {
  server.tool(tool.name, tool.description, tool.schema, async (params) =>
    textResult(await tool.execute(params, bridge)),
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
