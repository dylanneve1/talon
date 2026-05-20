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
 *   TALON_FRONTEND    — Frontend type: "telegram" | "teams" | "terminal" | "discord" (default: "telegram")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { composeTools } from "./index.js";
import { createBridge, textResult } from "./bridge.js";
import type { ToolFrontend } from "./types.js";

process.on("unhandledRejection", (err) => {
  const detail =
    err instanceof Error ? (err.stack ?? err.message) : String(err);
  const message = `[mcp-server] Unhandled rejection: ${detail}\n`;

  // Ensure we always exit even if stderr is backpressured
  const forceExit = setTimeout(() => process.exit(1), 1000);
  forceExit.unref();

  process.stderr.write(message, () => {
    clearTimeout(forceExit);
    process.exit(1);
  });
});

const VALID_FRONTENDS = new Set<ToolFrontend>([
  "telegram",
  "teams",
  "terminal",
  "discord",
]);
const BRIDGE_URL = process.env.TALON_BRIDGE_URL || "http://127.0.0.1:19876";
const CHAT_ID = process.env.TALON_CHAT_ID || "";
const rawFrontend = (process.env.TALON_FRONTEND || "telegram") as ToolFrontend;

if (!CHAT_ID) {
  console.warn(
    "TALON_CHAT_ID is not set — bridge calls will fail without a valid chat context.",
  );
}

if (!VALID_FRONTENDS.has(rawFrontend)) {
  console.error(
    `Invalid TALON_FRONTEND: "${rawFrontend}". Must be one of: ${[...VALID_FRONTENDS].join(", ")}`,
  );
  process.exit(1);
}
const FRONTEND = rawFrontend;

const bridge = createBridge(BRIDGE_URL, CHAT_ID);
const serverName = `${FRONTEND}-tools`;

// MCP `instructions` are injected into the model's system prompt by
// hosts that respect the protocol (e.g. agy, which writes them out
// to `~/.gemini/antigravity-cli/mcp/<server>/instructions.md` and
// includes them under `TOKEN_TYPE_MCP_TOOLS` in the system prompt).
// This is how Talon tells the model "you're running inside a chat
// frontend; don't try to render markdown image embeds — call `send`
// with the file path instead." Frontend-specific so terminal /
// Discord / Teams deployments get the right channel description.
const FRONTEND_INSTRUCTIONS: Record<string, string> = {
  telegram: `You are running inside the Talon Telegram bot. Your replies go to a real Telegram chat — not an IDE artifact viewer or browser.

Delivery rules:

  - **Plain text replies**: just respond normally. The text you output is forwarded as a Telegram message.
  - **Photos, documents, audio, video, voice notes, animations**: call the \`send\` tool with the absolute file path (or a public URL). Markdown image embeds like ![alt](path) will NOT render — they appear as literal text to the user. Files you create with write_to_file live only on the server's disk; the user cannot see them unless you \`send\` them.
  - **Reactions**: call \`react\` with an emoji to react to the user's message.
  - **Ending a turn**: end your reply normally; you do not have to call a tool. (\`end_turn\` is available if you want to explicitly stop without text.)
  - **Reading chat history**: use \`read_chat_history\`, \`search_chat_history\`, \`get_message_by_id\` rather than re-asking the user.
  - **Scheduled / deferred work**: \`create_cron_job\`, \`trigger_create\` schedule future runs that fire your tools back in this same chat.

The \`chat_id\` and \`message_id\` parameters are auto-populated for your current chat — you do not need to set them unless cross-posting to a different chat.`,

  teams: `You are running inside the Talon Microsoft Teams bot. Replies go to a Teams chat. Use \`send\` to deliver attachments; plain text responses are forwarded automatically.`,

  discord: `You are running inside the Talon Discord bot. Replies go to a Discord channel. Use \`send\` to deliver attachments; plain text responses are forwarded automatically.`,

  terminal: `You are running in Talon's terminal frontend. Plain text responses are printed to the user's terminal.`,
};

const server = new McpServer(
  { name: serverName, version: "3.0.0" },
  { instructions: FRONTEND_INSTRUCTIONS[FRONTEND] ?? FRONTEND_INSTRUCTIONS.telegram },
);

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

  // Graceful self-termination: when the parent closes our stdin (e.g. the SDK
  // tears down this MCP server during hot-swap), exit cleanly. This is the
  // OS-agnostic replacement for scanning /proc — the parent signals "you're done"
  // by closing the stdio pipe, and we respect it.
  process.stdin.on("end", () => {
    server.close().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
