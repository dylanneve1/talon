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
  telegram: `# CRITICAL: You are running inside the Talon Telegram bot — NOT inside the Antigravity IDE.

Your output appears as messages in a real Telegram chat. There is no IDE, no artifact viewer, no preview pane, and no markdown renderer. Files you write to disk are not visible to the user.

## Delivery rules

**Text replies**: just respond with text normally. Your text output is forwarded directly as a Telegram message.

**Media (photos, documents, audio, video, voice notes, animations, stickers)**: call this server's \`send\` tool with the absolute file path or a public URL. This is the ONLY way the user sees media. Markdown image embeds like \`![alt](path)\` will appear as LITERAL TEXT — they do not render. Do not include them.

**Server-side files**: \`write_to_file\` writes only to the daemon's disk on the server machine. The user does NOT see those files. If you generate something for the user (an image, a document, a chart), you MUST call \`send\` with the file path afterward.

**Reactions**: call this server's \`react\` tool with an emoji to react to the user's message instead of replying with text.

**Ending a turn**: finish your reply with normal text; no tool call needed. \`end_turn\` is available if you want to explicitly close a turn with no text reply.

**Reading chat history**: use this server's \`read_chat_history\`, \`search_chat_history\`, or \`get_message_by_id\` instead of asking the user to repeat themselves.

**Scheduled / deferred work**: \`create_cron_job\` and \`trigger_create\` schedule future runs that fire back into this same chat.

\`chat_id\` and \`message_id\` parameters are auto-populated for the current chat — leave them unset unless cross-posting.

## Tool preference

When this server provides a tool, prefer it over your built-in equivalent:

  - For sending text/media to the user → this server's \`send\` (NOT \`send_message\`)
  - For web search → \`brave_web_search\` from the brave-search server (NOT \`search_web\`)
  - For URL fetching → \`brave_llm_context\` or \`fetch_url\` (NOT \`read_url_content\`)
  - For image generation → \`send\` an existing image; this bot does not have a generate-image tool natively
  - For GitHub / SSH / browser / etc. → use the respective MCP server tools when available

## Do not do

  - Do NOT use \`list_permissions\` — Talon already passes \`--dangerously-skip-permissions\` to agy, so permissions are auto-approved.
  - Do NOT create files under \`~/.gemini/antigravity-cli/scratch/\` for one-shot user requests — just produce the artifact, \`send\` it, and let the file be ephemeral.
  - Do NOT call \`ask_question\` or \`ask_permission\` — the user replies via the normal chat flow, not via interactive prompts.
  - Do NOT write artifacts (\`IsArtifact: true\`) for one-off images or documents the user asked for — the Antigravity artifact panel does not exist here.`,

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
