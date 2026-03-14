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

// ── Polls & rich content ─────────────────────────────────────────────────────

server.tool(
  "send_poll",
  "Create a poll in the chat.",
  {
    question: z.string().describe("Poll question (1-300 chars)"),
    options: z.array(z.string()).describe("Poll options (2-10 choices)"),
    is_anonymous: z.boolean().optional().describe("Anonymous poll (default true)"),
    allows_multiple_answers: z.boolean().optional().describe("Allow multiple answers"),
    type: z.enum(["regular", "quiz"]).optional().describe("Poll type (default regular)"),
    correct_option_id: z.number().optional().describe("Correct answer index (required for quiz)"),
    explanation: z.string().optional().describe("Explanation shown after quiz answer"),
  },
  async (params) => {
    const result = await callBridge("send_poll", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "send_location",
  "Send a location pin to the chat.",
  {
    latitude: z.number().describe("Latitude"),
    longitude: z.number().describe("Longitude"),
  },
  async (params) => {
    const result = await callBridge("send_location", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "send_contact",
  "Share a contact card in the chat.",
  {
    phone_number: z.string().describe("Phone number"),
    first_name: z.string().describe("First name"),
    last_name: z.string().optional().describe("Last name"),
  },
  async (params) => {
    const result = await callBridge("send_contact", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "send_dice",
  "Send an animated dice/emoji. Returns a random value.",
  {
    emoji: z.enum(["🎲", "🎯", "🏀", "⚽", "🎳", "🎰"]).optional().describe("Dice emoji (default 🎲)"),
  },
  async (params) => {
    const result = await callBridge("send_dice", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "forward_message",
  "Forward a message from this chat to another chat or back to this chat.",
  {
    message_id: z.number().describe("Message ID to forward"),
    to_chat_id: z.number().optional().describe("Target chat ID (omit to forward within same chat)"),
  },
  async (params) => {
    const result = await callBridge("forward_message", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "unpin_message",
  "Unpin a message in the chat.",
  {
    message_id: z.number().optional().describe("Message ID to unpin (omit to unpin the most recent pin)"),
  },
  async (params) => {
    const result = await callBridge("unpin_message", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "get_chat_info",
  "Get information about the current chat (title, type, member count, description, etc.).",
  {},
  async () => {
    const result = await callBridge("get_chat_info", {});
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "get_chat_member",
  "Get information about a specific user in the chat.",
  {
    user_id: z.number().describe("User ID to look up"),
  },
  async (params) => {
    const result = await callBridge("get_chat_member", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  "set_chat_title",
  "Change the chat title (requires admin privileges).",
  {
    title: z.string().describe("New chat title"),
  },
  async (params) => {
    const result = await callBridge("set_chat_title", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "set_chat_description",
  "Change the chat description (requires admin privileges).",
  {
    description: z.string().describe("New description (0-255 chars)"),
  },
  async (params) => {
    const result = await callBridge("set_chat_description", params);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

// ── Chat history tools ───────────────────────────────────────────────────────

server.tool(
  "read_chat_history",
  "Read recent messages from the current chat. Returns the last N messages with sender names, timestamps, and message IDs you can use with reply_to or react.",
  {
    limit: z.number().optional().describe("Number of recent messages to return (default 20, max 50)"),
  },
  async (params) => {
    const result = await callBridge("read_history", { limit: params.limit ?? 20 });
    return { content: [{ type: "text" as const, text: (result as { text: string }).text }] };
  },
);

server.tool(
  "search_chat_history",
  "Search chat history for messages matching a keyword or phrase. Searches message text and sender names.",
  {
    query: z.string().describe("Search query (case-insensitive)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    const result = await callBridge("search_history", params);
    return { content: [{ type: "text" as const, text: (result as { text: string }).text }] };
  },
);

server.tool(
  "get_user_messages",
  "Get recent messages from a specific user in this chat.",
  {
    user_name: z.string().describe("User's name (partial match, case-insensitive)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (params) => {
    const result = await callBridge("get_user_messages", params);
    return { content: [{ type: "text" as const, text: (result as { text: string }).text }] };
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
