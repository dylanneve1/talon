#!/usr/bin/env node
/**
 * MCP server that exposes Telegram bot actions as tools.
 * Spawned by the Claude Agent SDK as a subprocess.
 * Communicates with the main bot process via a simple HTTP bridge.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.TALON_BRIDGE_URL || "http://127.0.0.1:19876";

async function callBridge(action: string, params: Record<string, unknown>): Promise<unknown> {
  const resp = await fetch(`${BRIDGE_URL}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...params }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge error (${resp.status}): ${text}`);
  }
  return resp.json();
}

const server = new McpServer({ name: "telegram-tools", version: "1.0.0" });

server.tool(
  "send_message",
  "Send a text message to the current Telegram chat. Use this instead of just outputting text when you want to send multiple separate messages or control delivery.",
  {
    text: z.string().describe("Message text (supports Markdown)"),
    reply_to_message_id: z.number().optional().describe("Message ID to reply to"),
  },
  async (params) => {
    const result = await callBridge("send_message", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "react",
  "Add an emoji reaction to a message in the current chat.",
  {
    message_id: z.number().describe("ID of the message to react to"),
    emoji: z.string().describe("Emoji to react with (e.g. 👍, ❤️, 🔥, 😂, 🎉, 👀)"),
  },
  async (params) => {
    const result = await callBridge("react", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "reply_to",
  "Reply to a specific message by its ID.",
  {
    message_id: z.number().describe("ID of the message to reply to"),
    text: z.string().describe("Reply text (supports Markdown)"),
  },
  async (params) => {
    const result = await callBridge("reply_to", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "edit_message",
  "Edit a previously sent message.",
  {
    message_id: z.number().describe("ID of the message to edit (must be one of our messages)"),
    text: z.string().describe("New message text"),
  },
  async (params) => {
    const result = await callBridge("edit_message", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "delete_message",
  "Delete a message from the chat (must be one of our messages, or in a group where we have delete permissions).",
  {
    message_id: z.number().describe("ID of the message to delete"),
  },
  async (params) => {
    const result = await callBridge("delete_message", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "pin_message",
  "Pin a message in the chat.",
  {
    message_id: z.number().describe("ID of the message to pin"),
  },
  async (params) => {
    const result = await callBridge("pin_message", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "send_file",
  "Send a file from the workspace as a Telegram document.",
  {
    file_path: z.string().describe("Path to the file in the workspace"),
    caption: z.string().optional().describe("Optional caption for the file"),
  },
  async (params) => {
    const result = await callBridge("send_file", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "send_photo",
  "Send an image file as a Telegram photo (rendered inline, not as a document).",
  {
    file_path: z.string().describe("Path to the image file"),
    caption: z.string().optional().describe("Optional caption"),
  },
  async (params) => {
    const result = await callBridge("send_photo", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
