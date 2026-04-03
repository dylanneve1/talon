#!/usr/bin/env node
/**
 * MCP server — Teams tools for the Claude Agent SDK.
 * Communicates with the main bot process via HTTP bridge.
 *
 * Teams-specific: only exposes tools that work via Power Automate webhooks.
 * No reactions, no media uploads, no message editing/deletion.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.TALON_BRIDGE_URL || "http://127.0.0.1:19876";
const CHAT_ID = process.env.TALON_CHAT_ID || "";

async function callBridge(
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(`${BRIDGE_URL}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, _chatId: CHAT_ID, ...params }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge error (${resp.status}): ${text}`);
  }
  return resp.json();
}

function textResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const r = result as { text?: string; error?: string };
  return {
    content: [
      { type: "text" as const, text: r.text ?? JSON.stringify(result) },
    ],
  };
}

const server = new McpServer({ name: "teams-tools", version: "1.0.0" });

// ── Send message ─────────────────────────────────────────────────────────────

server.tool(
  "send_message",
  `Send a message to the Teams chat. Supports Markdown formatting.

Examples:
  send_message(text="Hello!")
  send_message(text="Here's a **bold** message with \`code\`")`,
  {
    text: z.string().describe("Message text. Supports Markdown."),
  },
  async (params) => textResult(await callBridge("send_message", params)),
);

server.tool(
  "send_message_with_buttons",
  `Send a message with clickable link buttons. Buttons appear below the message as Adaptive Card actions.

Example: send_message_with_buttons(text="Choose:", rows=[[{"text":"Docs","url":"https://..."}]])`,
  {
    text: z.string().describe("Message text"),
    rows: z
      .array(
        z.array(
          z.object({
            text: z.string().describe("Button label"),
            url: z.string().optional().describe("URL to open when clicked"),
          }),
        ),
      )
      .describe("Button rows"),
  },
  async (params) =>
    textResult(await callBridge("send_message_with_buttons", params)),
);

// ── Chat info ────────────────────────────────────────────────────────────────

server.tool("get_chat_info", "Get info about the current chat.", {}, async () =>
  textResult(await callBridge("get_chat_info", {})),
);

// ── Web tools ────────────────────────────────────────────────────────────────

server.tool(
  "web_search",
  "Search the web. Returns titles, URLs, and snippets.",
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default 5, max 10)"),
  },
  async (params) => textResult(await callBridge("web_search", params)),
);

server.tool(
  "fetch_url",
  "Fetch a URL — web pages return text content, images are downloaded to workspace.",
  {
    url: z.string().describe("The URL to fetch"),
  },
  async (params) => textResult(await callBridge("fetch_url", params)),
);

// ── Cron jobs ────────────────────────────────────────────────────────────────

server.tool(
  "create_cron_job",
  `Create a persistent recurring scheduled job. Jobs survive restarts.

Cron format: "minute hour day month weekday" (5 fields)
Examples:
  "0 9 * * *"     = every day at 9:00 AM
  "*/15 * * * *"  = every 15 minutes

Type "message" sends the content as a text message.
Type "query" runs the content as a Claude prompt with full tool access.`,
  {
    name: z.string().describe("Human-readable name for the job"),
    schedule: z.string().describe("Cron expression (5-field)"),
    type: z.enum(["message", "query"]).describe("Job type"),
    content: z.string().describe("Message text or query prompt"),
    timezone: z.string().optional().describe("IANA timezone"),
  },
  async (params) => textResult(await callBridge("create_cron_job", params)),
);

server.tool(
  "list_cron_jobs",
  "List all cron jobs in the current chat.",
  {},
  async () => textResult(await callBridge("list_cron_jobs", {})),
);

server.tool(
  "edit_cron_job",
  "Edit an existing cron job.",
  {
    job_id: z.string().describe("Job ID to edit"),
    name: z.string().optional(),
    schedule: z.string().optional(),
    type: z.enum(["message", "query"]).optional(),
    content: z.string().optional(),
    enabled: z.boolean().optional(),
    timezone: z.string().optional(),
  },
  async (params) => textResult(await callBridge("edit_cron_job", params)),
);

server.tool(
  "delete_cron_job",
  "Delete a cron job permanently.",
  {
    job_id: z.string().describe("Job ID to delete"),
  },
  async (params) => textResult(await callBridge("delete_cron_job", params)),
);

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
