#!/usr/bin/env node
/**
 * MCP server — Telegram tools for the Claude Agent SDK.
 * Communicates with the main bot process via HTTP bridge.
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

function textResult(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  const r = result as { text?: string; error?: string };
  return { content: [{ type: "text" as const, text: r.text ?? JSON.stringify(result) }] };
}

const server = new McpServer({ name: "telegram-tools", version: "2.0.0" });

// ── Unified send tool ────────────────────────────────────────────────────────

server.tool(
  "send",
  `Send content to the current Telegram chat. Supports text, photos, videos, files, voice, stickers, polls, locations, contacts, dice, and GIFs.

Examples:
  Text: send(type="text", text="Hello!")
  Reply: send(type="text", text="Yes!", reply_to=12345)
  With buttons: send(type="text", text="Pick one", buttons=[[{"text":"A","callback_data":"a"}]])
  Photo: send(type="photo", file_path="/path/to/img.jpg", caption="Look!")
  File: send(type="file", file_path="/path/to/report.pdf")
  Poll: send(type="poll", question="Best language?", options=["Rust","Go","TS"])
  Dice: send(type="dice")
  Location: send(type="location", latitude=37.7749, longitude=-122.4194)
  Sticker: send(type="sticker", file_id="CAACAgI...")`,
  {
    type: z.enum(["text", "photo", "file", "video", "voice", "animation", "sticker", "poll", "location", "contact", "dice"]).describe("Content type to send"),
    text: z.string().optional().describe("Message text (for type=text). Supports Markdown."),
    reply_to: z.number().optional().describe("Message ID to reply to"),
    file_path: z.string().optional().describe("Workspace file path (for photo/file/video/voice/animation)"),
    file_id: z.string().optional().describe("Telegram file_id (for sticker)"),
    caption: z.string().optional().describe("Caption for media"),
    buttons: z.array(z.array(z.object({
      text: z.string(),
      url: z.string().optional(),
      callback_data: z.string().optional(),
    }))).optional().describe("Inline keyboard button rows"),
    question: z.string().optional().describe("Poll question"),
    options: z.array(z.string()).optional().describe("Poll options"),
    is_anonymous: z.boolean().optional().describe("Anonymous poll"),
    correct_option_id: z.number().optional().describe("Quiz correct answer index"),
    explanation: z.string().optional().describe("Quiz explanation"),
    latitude: z.number().optional().describe("Location latitude"),
    longitude: z.number().optional().describe("Location longitude"),
    phone_number: z.string().optional().describe("Contact phone"),
    first_name: z.string().optional().describe("Contact first name"),
    last_name: z.string().optional().describe("Contact last name"),
    emoji: z.string().optional().describe("Dice emoji (🎲🎯🏀⚽🎳🎰)"),
    delay_seconds: z.number().optional().describe("Schedule: delay before sending (1-3600)"),
  },
  async (params) => {
    const { type } = params;
    switch (type) {
      case "text": {
        if (params.delay_seconds) {
          const result = await callBridge("schedule_message", { text: params.text, delay_seconds: params.delay_seconds });
          return textResult(result);
        }
        if (params.buttons) {
          const result = await callBridge("send_message_with_buttons", { text: params.text, rows: params.buttons, reply_to_message_id: params.reply_to });
          return textResult(result);
        }
        const result = await callBridge("send_message", { text: params.text, reply_to_message_id: params.reply_to });
        return textResult(result);
      }
      case "photo": return textResult(await callBridge("send_photo", { file_path: params.file_path, caption: params.caption, reply_to: params.reply_to }));
      case "file": return textResult(await callBridge("send_file", { file_path: params.file_path, caption: params.caption, reply_to: params.reply_to }));
      case "video": return textResult(await callBridge("send_video", { file_path: params.file_path, caption: params.caption, reply_to: params.reply_to }));
      case "voice": return textResult(await callBridge("send_voice", { file_path: params.file_path, caption: params.caption, reply_to: params.reply_to }));
      case "animation": return textResult(await callBridge("send_animation", { file_path: params.file_path, caption: params.caption, reply_to: params.reply_to }));
      case "sticker": return textResult(await callBridge("send_sticker", { file_id: params.file_id, reply_to: params.reply_to }));
      case "poll": return textResult(await callBridge("send_poll", {
        question: params.question, options: params.options,
        is_anonymous: params.is_anonymous, correct_option_id: params.correct_option_id,
        explanation: params.explanation, type: params.correct_option_id !== undefined ? "quiz" : "regular",
      }));
      case "location": return textResult(await callBridge("send_location", { latitude: params.latitude, longitude: params.longitude }));
      case "contact": return textResult(await callBridge("send_contact", { phone_number: params.phone_number, first_name: params.first_name, last_name: params.last_name }));
      case "dice": return textResult(await callBridge("send_dice", { emoji: params.emoji }));
      default: return textResult({ ok: false, error: `Unknown type: ${type}` });
    }
  },
);

// ── Message actions ──────────────────────────────────────────────────────────

server.tool(
  "react",
  "Add an emoji reaction to a message. Valid: 👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷 🤷‍♂ 🤷‍♀ 😡",
  {
    message_id: z.number().describe("Message ID"),
    emoji: z.string().describe("Reaction emoji"),
  },
  async (params) => textResult(await callBridge("react", params)),
);

server.tool(
  "edit_message",
  "Edit a previously sent message.",
  { message_id: z.number(), text: z.string() },
  async (params) => textResult(await callBridge("edit_message", params)),
);

server.tool(
  "delete_message",
  "Delete a message.",
  { message_id: z.number() },
  async (params) => textResult(await callBridge("delete_message", params)),
);

server.tool(
  "forward_message",
  "Forward a message within the chat.",
  { message_id: z.number() },
  async (params) => textResult(await callBridge("forward_message", params)),
);

server.tool(
  "pin_message",
  "Pin a message.",
  { message_id: z.number() },
  async (params) => textResult(await callBridge("pin_message", params)),
);

server.tool(
  "unpin_message",
  "Unpin a message.",
  { message_id: z.number().optional() },
  async (params) => textResult(await callBridge("unpin_message", params)),
);

// ── Chat info ────────────────────────────────────────────────────────────────

server.tool("get_chat_info", "Get chat title, type, member count.", {}, async () => textResult(await callBridge("get_chat_info", {})));
server.tool("get_chat_admins", "List chat administrators.", {}, async () => textResult(await callBridge("get_chat_admins", {})));
server.tool("get_chat_member_count", "Get total member count.", {}, async () => textResult(await callBridge("get_chat_member_count", {})));
server.tool("set_chat_title", "Change chat title (admin).", { title: z.string() }, async (p) => textResult(await callBridge("set_chat_title", p)));
server.tool("set_chat_description", "Change chat description (admin).", { description: z.string() }, async (p) => textResult(await callBridge("set_chat_description", p)));

// ── Chat history ─────────────────────────────────────────────────────────────

server.tool(
  "read_chat_history",
  "Read messages from the chat. Use 'before' to go back in time (e.g. '2026-03-13').",
  {
    limit: z.number().optional().describe("Number of messages (default 30, max 100)"),
    before: z.string().optional().describe("Fetch messages before this date (ISO format)"),
    offset_id: z.number().optional().describe("Fetch before this message ID"),
  },
  async (params) => textResult(await callBridge("read_history", { limit: params.limit ?? 30, before: params.before, offset_id: params.offset_id })),
);

server.tool(
  "search_chat_history",
  "Search messages by keyword.",
  { query: z.string(), limit: z.number().optional() },
  async (params) => textResult(await callBridge("search_history", params)),
);

server.tool(
  "get_user_messages",
  "Get messages from a specific user.",
  { user_name: z.string(), limit: z.number().optional() },
  async (params) => textResult(await callBridge("get_user_messages", params)),
);

server.tool(
  "get_message_by_id",
  "Get a specific message by ID.",
  { message_id: z.number() },
  async (params) => textResult(await callBridge("get_message_by_id", params)),
);

// ── Members ──────────────────────────────────────────────────────────────────

server.tool(
  "list_chat_members",
  "List chat members with names, IDs, online status, badges.",
  { limit: z.number().optional() },
  async (params) => textResult(await callBridge("list_known_users", { limit: params.limit })),
);

server.tool(
  "get_member_info",
  "Get detailed info about a user by ID.",
  { user_id: z.number() },
  async (params) => textResult(await callBridge("get_member_info", params)),
);

// ── Scheduling ───────────────────────────────────────────────────────────────

server.tool(
  "cancel_scheduled",
  "Cancel a scheduled message.",
  { schedule_id: z.string() },
  async (params) => textResult(await callBridge("cancel_scheduled", params)),
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
