#!/usr/bin/env node
/**
 * MCP server — Telegram tools for the Claude Agent SDK.
 * Communicates with the main bot process via HTTP bridge.
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
    // Include chatId so bridge can verify it matches the active context
    body: JSON.stringify({ action, _chatId: CHAT_ID, ...params }),
    signal: AbortSignal.timeout(120_000), // 2-minute timeout prevents hanging
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

const server = new McpServer({ name: "telegram-tools", version: "2.0.0" });

// ── Unified send tool ────────────────────────────────────────────────────────

server.tool(
  "send",
  `Send content to the CURRENT Telegram chat. For other chats or users use message_user instead. Supports text, photos, videos, files, audio, voice, stickers, polls, locations, contacts, dice, and GIFs.

Examples:
  Text: send(type="text", text="Hello!")
  Reply: send(type="text", text="Yes!", reply_to=12345)
  With buttons: send(type="text", text="Pick one", buttons=[[{"text":"A","callback_data":"a"}]])
  Photo: send(type="photo", file_path="/path/to/img.jpg", caption="Look!")
  File: send(type="file", file_path="/path/to/report.pdf")
  Audio: send(type="audio", file_path="/path/to/song.mp3", title="Song Name", performer="Artist")
  Poll: send(type="poll", question="Best language?", options=["Rust","Go","TS"])
  Dice: send(type="dice")
  Location: send(type="location", latitude=37.7749, longitude=-122.4194)
  Sticker: send(type="sticker", file_id="CAACAgI...")`,
  {
    type: z
      .enum([
        "text",
        "photo",
        "file",
        "video",
        "voice",
        "audio",
        "animation",
        "sticker",
        "poll",
        "location",
        "contact",
        "dice",
      ])
      .describe("Content type to send"),
    text: z
      .string()
      .optional()
      .describe("Message text (for type=text). Supports Markdown."),
    reply_to: z.number().optional().describe("Message ID to reply to"),
    file_path: z
      .string()
      .optional()
      .describe("Workspace file path (for photo/file/video/voice/animation)"),
    file_id: z.string().optional().describe("Telegram file_id (for sticker)"),
    caption: z.string().optional().describe("Caption for media"),
    buttons: z
      .array(
        z.array(
          z.object({
            text: z.string(),
            url: z.string().optional(),
            callback_data: z.string().optional(),
          }),
        ),
      )
      .optional()
      .describe("Inline keyboard button rows"),
    question: z.string().optional().describe("Poll question"),
    options: z.array(z.string()).optional().describe("Poll options"),
    is_anonymous: z.boolean().optional().describe("Anonymous poll"),
    correct_option_id: z
      .number()
      .optional()
      .describe("Quiz correct answer index"),
    explanation: z.string().optional().describe("Quiz explanation"),
    latitude: z.number().optional().describe("Location latitude"),
    longitude: z.number().optional().describe("Location longitude"),
    phone_number: z.string().optional().describe("Contact phone"),
    first_name: z.string().optional().describe("Contact first name"),
    last_name: z.string().optional().describe("Contact last name"),
    title: z.string().optional().describe("Audio title (for type=audio)"),
    performer: z.string().optional().describe("Audio performer/artist (for type=audio)"),
    emoji: z.string().optional().describe("Dice emoji (🎲🎯🏀⚽🎳🎰)"),
    delay_seconds: z
      .number()
      .optional()
      .describe("Schedule: delay before sending (1-3600)"),
  },
  async (params) => {
    const { type } = params;
    switch (type) {
      case "text": {
        if (params.delay_seconds) {
          const result = await callBridge("schedule_message", {
            text: params.text,
            delay_seconds: params.delay_seconds,
          });
          return textResult(result);
        }
        if (params.buttons) {
          const result = await callBridge("send_message_with_buttons", {
            text: params.text,
            rows: params.buttons,
            reply_to_message_id: params.reply_to,
          });
          return textResult(result);
        }
        const result = await callBridge("send_message", {
          text: params.text,
          reply_to_message_id: params.reply_to,
        });
        return textResult(result);
      }
      case "photo":
        return textResult(
          await callBridge("send_photo", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
          }),
        );
      case "file":
        return textResult(
          await callBridge("send_file", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
          }),
        );
      case "video":
        return textResult(
          await callBridge("send_video", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
          }),
        );
      case "voice":
        return textResult(
          await callBridge("send_voice", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
          }),
        );
      case "audio":
        return textResult(
          await callBridge("send_audio", {
            file_path: params.file_path,
            caption: params.caption,
            title: params.title,
            performer: params.performer,
            reply_to: params.reply_to,
          }),
        );
      case "animation":
        return textResult(
          await callBridge("send_animation", {
            file_path: params.file_path,
            caption: params.caption,
            reply_to: params.reply_to,
          }),
        );
      case "sticker":
        return textResult(
          await callBridge("send_sticker", {
            file_id: params.file_id,
            reply_to: params.reply_to,
          }),
        );
      case "poll":
        return textResult(
          await callBridge("send_poll", {
            question: params.question,
            options: params.options,
            is_anonymous: params.is_anonymous,
            correct_option_id: params.correct_option_id,
            explanation: params.explanation,
            type: params.correct_option_id !== undefined ? "quiz" : "regular",
          }),
        );
      case "location":
        return textResult(
          await callBridge("send_location", {
            latitude: params.latitude,
            longitude: params.longitude,
          }),
        );
      case "contact":
        return textResult(
          await callBridge("send_contact", {
            phone_number: params.phone_number,
            first_name: params.first_name,
            last_name: params.last_name,
          }),
        );
      case "dice":
        return textResult(
          await callBridge("send_dice", { emoji: params.emoji }),
        );
      default:
        return textResult({ ok: false, error: `Unknown type: ${type}` });
    }
  },
);

// ── Cross-chat messaging ─────────────────────────────────────────────────────

server.tool(
  "message_user",
  `Send a message to ANY Telegram user, group, or channel — not just the current chat.
Use this to slide into someone's DMs, message a contact, or post to another group.

Target formats:
  @username    → send by Telegram username
  +12125551234 → send by phone number (must be a contact)
  352042062    → send by numeric Telegram user/chat ID

Examples:
  message_user(to="@risen", text="hey what's up")
  message_user(to="+17738209203", text="got your number")
  message_user(to="352042062", text="direct by ID")
  message_user(to="@mygroup", type="photo", file_path="/workspace/img.jpg", caption="check this out")`,
  {
    to: z.string().describe("Target: @username, +phone number, or numeric chat/user ID"),
    text: z.string().optional().describe("Message text (for type=text)"),
    type: z.enum(["text", "photo", "file", "video", "voice"]).optional().describe("Content type (default: text)"),
    file_path: z.string().optional().describe("File path for photo/file/video/voice"),
    caption: z.string().optional().describe("Caption for media"),
  },
  async (p) => textResult(await callBridge("send_to_chat", p)),
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

server.tool(
  "stop_poll",
  "Stop an active poll and get the final results. Returns vote counts for each option.",
  { message_id: z.number().describe("Message ID of the poll to stop") },
  async (params) => textResult(await callBridge("stop_poll", params)),
);

// ── Chat info ────────────────────────────────────────────────────────────────

server.tool(
  "get_chat_info",
  "Get chat title, type, member count.",
  {},
  async () => textResult(await callBridge("get_chat_info", {})),
);
server.tool("get_chat_admins", "List chat administrators.", {}, async () =>
  textResult(await callBridge("get_chat_admins", {})),
);
server.tool("get_chat_member_count", "Get total member count.", {}, async () =>
  textResult(await callBridge("get_chat_member_count", {})),
);
server.tool(
  "set_chat_title",
  "Change chat title (admin).",
  { title: z.string() },
  async (p) => textResult(await callBridge("set_chat_title", p)),
);
server.tool(
  "set_chat_description",
  "Change chat description (admin).",
  { description: z.string() },
  async (p) => textResult(await callBridge("set_chat_description", p)),
);

// ── Chat history ─────────────────────────────────────────────────────────────

server.tool(
  "read_chat_history",
  "Read messages from the chat. Use 'before' to go back in time (e.g. '2026-03-13').",
  {
    limit: z
      .number()
      .optional()
      .describe("Number of messages (default 30, max 100)"),
    before: z
      .string()
      .optional()
      .describe("Fetch messages before this date (ISO format)"),
    offset_id: z.number().optional().describe("Fetch before this message ID"),
  },
  async (params) =>
    textResult(
      await callBridge("read_history", {
        limit: params.limit ?? 30,
        before: params.before,
        offset_id: params.offset_id,
      }),
    ),
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

server.tool(
  "download_media",
  "Download a photo, document, or other media from a message by its ID. Saves the file to the workspace and returns the file path so you can read/analyze it. Use this when you see a [photo] or [document] in chat history but don't have the file.",
  {
    message_id: z.number().describe("Message ID containing the media to download"),
  },
  async (params) => textResult(await callBridge("download_media", params)),
);

server.tool(
  "get_sticker_pack",
  "Get all stickers in a sticker pack by its name. Returns emoji + file_id for each sticker so you can send them. Use when you see a sticker set name in chat history.",
  {
    set_name: z.string().describe("Sticker set name (e.g. 'AnimatedEmojies' or from sticker metadata)"),
  },
  async (params) => textResult(await callBridge("get_sticker_pack", params)),
);

server.tool(
  "download_sticker",
  "Download a sticker image to workspace so you can view its contents. Returns the file path.",
  {
    file_id: z.string().describe("Sticker file_id from chat history or sticker pack listing"),
  },
  async (params) => textResult(await callBridge("download_sticker", params)),
);

// ── Members ──────────────────────────────────────────────────────────────────

server.tool(
  "list_chat_members",
  "List chat members with names, IDs, online status, badges.",
  { limit: z.number().optional() },
  async (params) =>
    textResult(await callBridge("list_known_users", { limit: params.limit })),
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

// ── Cron jobs ────────────────────────────────────────────────────────────────

server.tool(
  "create_cron_job",
  `Create a persistent recurring scheduled job. Jobs survive restarts.

Cron format: "minute hour day month weekday" (5 fields)
Examples:
  "0 9 * * *"     = every day at 9:00 AM
  "30 14 * * 1-5" = weekdays at 2:30 PM
  "*/15 * * * *"  = every 15 minutes
  "0 0 1 * *"     = first day of every month at midnight
  "0 8 * * 1"     = every Monday at 8:00 AM

Type "message" sends the content as a text message.
Type "query" runs the content as a Claude prompt with full tool access (can search, create files, send messages, etc).`,
  {
    name: z.string().describe("Human-readable name for the job"),
    schedule: z.string().describe("Cron expression (5-field: minute hour day month weekday)"),
    type: z.enum(["message", "query"]).describe("Job type: 'message' sends text, 'query' runs a Claude prompt"),
    content: z.string().describe("Message text or query prompt"),
    timezone: z.string().optional().describe("IANA timezone (e.g. 'America/New_York'). Defaults to system timezone."),
  },
  async (params) => textResult(await callBridge("create_cron_job", params)),
);

server.tool(
  "list_cron_jobs",
  "List all cron jobs in the current chat with their status, schedule, run count, and next run time.",
  {},
  async () => textResult(await callBridge("list_cron_jobs", {})),
);

server.tool(
  "edit_cron_job",
  "Edit an existing cron job. Only provide the fields you want to change.",
  {
    job_id: z.string().describe("Job ID to edit"),
    name: z.string().optional().describe("New name"),
    schedule: z.string().optional().describe("New cron expression"),
    type: z.enum(["message", "query"]).optional().describe("New job type"),
    content: z.string().optional().describe("New content"),
    enabled: z.boolean().optional().describe("Enable or disable the job"),
    timezone: z.string().optional().describe("New IANA timezone"),
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

server.tool(
  "save_sticker_pack",
  "Save a sticker pack's file_ids to workspace for quick reuse. Once saved, you can read the JSON file to find stickers by emoji and send them instantly.",
  {
    set_name: z.string().describe("Sticker set name"),
  },
  async (params) => textResult(await callBridge("save_sticker_pack", params)),
);

// ── Sticker pack management ──────────────────────────────────────────────────

server.tool(
  "create_sticker_set",
  `Create a new sticker pack owned by a user. The bot will be the creator.
Sticker images must be PNG/WEBP, max 512x512px for static stickers.
The set name will automatically get "_by_<botname>" appended if needed.

Example: create_sticker_set(user_id=123, name="cool_pack", title="Cool Stickers", file_path="/path/to/sticker.png", emoji_list=["😎"])`,
  {
    user_id: z.number().describe("Telegram user ID who will own the pack"),
    name: z.string().describe("Short name for the pack (a-z, 0-9, underscores). Will get _by_<botname> appended."),
    title: z.string().describe("Display title for the pack (1-64 chars)"),
    file_path: z.string().describe("Path to the sticker image file (PNG/WEBP, 512x512 max)"),
    emoji_list: z.array(z.string()).optional().describe("Emojis for this sticker (default: ['🎨'])"),
    format: z.enum(["static", "animated", "video"]).optional().describe("Sticker format (default: static)"),
  },
  async (params) => textResult(await callBridge("create_sticker_set", params)),
);

server.tool(
  "add_sticker_to_set",
  "Add a new sticker to an existing sticker pack created by the bot.",
  {
    user_id: z.number().describe("Telegram user ID who owns the pack"),
    name: z.string().describe("Sticker set name (including _by_<botname>)"),
    file_path: z.string().describe("Path to the sticker image file"),
    emoji_list: z.array(z.string()).optional().describe("Emojis for this sticker (default: ['🎨'])"),
    format: z.enum(["static", "animated", "video"]).optional().describe("Sticker format (default: static)"),
  },
  async (params) => textResult(await callBridge("add_sticker_to_set", params)),
);

server.tool(
  "delete_sticker_from_set",
  "Remove a specific sticker from a pack by its file_id.",
  {
    sticker_file_id: z.string().describe("file_id of the sticker to remove (get from get_sticker_pack)"),
  },
  async (params) => textResult(await callBridge("delete_sticker_from_set", params)),
);

server.tool(
  "set_sticker_set_title",
  "Change the title of a sticker pack created by the bot.",
  {
    name: z.string().describe("Sticker set name"),
    title: z.string().describe("New title (1-64 chars)"),
  },
  async (params) => textResult(await callBridge("set_sticker_set_title", params)),
);

server.tool(
  "delete_sticker_set",
  "Permanently delete an entire sticker pack created by the bot.",
  {
    name: z.string().describe("Sticker set name to delete"),
  },
  async (params) => textResult(await callBridge("delete_sticker_set", params)),
);

// ── Chat analytics ───────────────────────────────────────────────────────────

server.tool(
  "get_pinned_messages",
  "Get all pinned messages in the current chat.",
  {},
  async () => textResult(await callBridge("get_pinned_messages", {})),
);

server.tool(
  "online_count",
  "Get how many members are currently online or recently active.",
  {},
  async () => textResult(await callBridge("online_count", {})),
);

server.tool(
  "list_media",
  "List recent photos, documents, and other media in the current chat with file paths. Use this to find a previously sent photo or file to re-read or reference.",
  {
    limit: z.number().optional().describe("Number of entries (default 10, max 20)"),
  },
  async (params) => textResult(await callBridge("list_media", { limit: params.limit })),
);

// ── Userbot: Profile management ─────────────────────────────────────────────

server.tool(
  "get_my_profile",
  "View your own Telegram account details: name, username, bio, phone, ID.",
  {},
  async () => textResult(await callBridge("get_my_profile", {})),
);

server.tool(
  "edit_profile",
  "Edit your own Telegram profile (name and/or bio). Provide any combination of fields.",
  {
    first_name: z.string().optional().describe("New first name"),
    last_name: z.string().optional().describe("New last name (empty string to clear)"),
    about: z.string().optional().describe("New bio/about text (empty string to clear)"),
  },
  async (p) => textResult(await callBridge("edit_profile", p)),
);

server.tool(
  "set_username",
  "Change your Telegram @username. Pass empty string to remove it.",
  { username: z.string().describe("New username without @, or empty string to remove") },
  async (p) => textResult(await callBridge("set_username", p)),
);

server.tool(
  "set_profile_photo",
  "Set a new profile photo from a file in the workspace.",
  { file_path: z.string().describe("Path to the image file (JPG/PNG)") },
  async (p) => textResult(await callBridge("set_profile_photo", p)),
);

server.tool(
  "delete_profile_photos",
  "Delete your current profile photo(s).",
  { all: z.boolean().optional().describe("If true, delete all profile photos; otherwise just the most recent") },
  async (p) => textResult(await callBridge("delete_profile_photos", p)),
);

// ── Userbot: Contacts ────────────────────────────────────────────────────────

server.tool(
  "get_contacts",
  "List all Telegram contacts (name, username, phone, ID).",
  {},
  async () => textResult(await callBridge("get_contacts", {})),
);

server.tool(
  "add_contact",
  "Add a Telegram user as a contact by phone number.",
  {
    phone: z.string().describe("Phone number with country code (e.g. +12125551234)"),
    first_name: z.string().describe("Contact first name"),
    last_name: z.string().optional().describe("Contact last name"),
  },
  async (p) => textResult(await callBridge("add_contact", p)),
);

server.tool(
  "delete_contact",
  "Remove a user from your contacts.",
  { user_id: z.number().describe("Telegram user ID") },
  async (p) => textResult(await callBridge("delete_contact", p)),
);

server.tool(
  "block_user",
  "Block a user (they can no longer message you).",
  { user_id: z.number().describe("Telegram user ID to block") },
  async (p) => textResult(await callBridge("block_user", p)),
);

server.tool(
  "unblock_user",
  "Unblock a previously blocked user.",
  { user_id: z.number().describe("Telegram user ID to unblock") },
  async (p) => textResult(await callBridge("unblock_user", p)),
);

server.tool(
  "get_blocked_users",
  "List all users you have blocked.",
  {},
  async () => textResult(await callBridge("get_blocked_users", {})),
);

// ── Userbot: Chat & group management ────────────────────────────────────────

server.tool(
  "set_chat_photo",
  "Set a new photo for a group or channel.",
  {
    file_path: z.string().describe("Path to the image file"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_chat_photo", p)),
);

server.tool(
  "join_chat",
  "Join a public group, channel, or private chat by invite link or username.",
  { invite: z.string().describe("Username (e.g. @mygroup) or invite link (t.me/+...)") },
  async (p) => textResult(await callBridge("join_chat", p)),
);

server.tool(
  "leave_chat",
  "Leave a group or channel.",
  { chat_id: z.number().optional().describe("Chat to leave (defaults to current chat)") },
  async (p) => textResult(await callBridge("leave_chat", p)),
);

server.tool(
  "create_group",
  "Create a basic Telegram group with specified members.",
  {
    title: z.string().describe("Group title"),
    user_ids: z.array(z.number()).describe("Array of user IDs to add"),
  },
  async (p) => textResult(await callBridge("create_group", p)),
);

server.tool(
  "create_supergroup",
  "Create a supergroup or channel.",
  {
    title: z.string().describe("Group title"),
    description: z.string().optional().describe("Group description"),
  },
  async (p) => textResult(await callBridge("create_supergroup", p)),
);

server.tool(
  "invite_to_chat",
  "Invite users to a group by their user IDs.",
  {
    user_ids: z.array(z.number()).describe("Array of user IDs to invite"),
    chat_id: z.number().optional().describe("Target group (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("invite_to_chat", p)),
);

server.tool(
  "delete_chat",
  "Delete a group (only if you are the creator).",
  { chat_id: z.number().optional().describe("Group to delete (defaults to current chat)") },
  async (p) => textResult(await callBridge("delete_chat", p)),
);

// ── Userbot: Member management ───────────────────────────────────────────────

server.tool(
  "kick_member",
  "Kick and ban a member from a group.",
  {
    user_id: z.number().describe("User ID to kick"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("kick_member", p)),
);

server.tool(
  "unban_member",
  "Unban a previously kicked member, allowing them to rejoin.",
  {
    user_id: z.number().describe("User ID to unban"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("unban_member", p)),
);

server.tool(
  "restrict_member",
  "Restrict a group member's posting rights.",
  {
    user_id: z.number().describe("User ID to restrict"),
    no_messages: z.boolean().optional().describe("Prevent sending messages"),
    no_media: z.boolean().optional().describe("Prevent sending media"),
    no_stickers: z.boolean().optional().describe("Prevent sending stickers"),
    until_date: z.number().optional().describe("Unix timestamp when restriction expires (0 = permanent)"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("restrict_member", p)),
);

server.tool(
  "promote_admin",
  "Promote a user to admin with specified rights.",
  {
    user_id: z.number().describe("User ID to promote"),
    can_manage_chat: z.boolean().optional(),
    can_post_messages: z.boolean().optional(),
    can_edit_messages: z.boolean().optional(),
    can_delete_messages: z.boolean().optional(),
    can_ban_users: z.boolean().optional(),
    can_invite_users: z.boolean().optional(),
    can_pin_messages: z.boolean().optional(),
    can_change_info: z.boolean().optional(),
    rank: z.string().optional().describe("Custom admin title shown next to their name"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("promote_admin", p)),
);

server.tool(
  "demote_admin",
  "Remove admin rights from a user.",
  {
    user_id: z.number().describe("User ID to demote"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("demote_admin", p)),
);

server.tool(
  "set_member_tag",
  "Set a visual member tag (custom title shown next to name) without granting admin powers. Works in supergroups.",
  {
    user_id: z.number().describe("User ID to tag"),
    tag: z.string().describe("Tag text to display (e.g. 'VIP', 'Mod', 'Legend')"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_member_tag", p)),
);

server.tool(
  "toggle_slow_mode",
  "Set slow mode delay for a group (how many seconds between messages per user).",
  {
    seconds: z.number().describe("Delay in seconds (0 to disable, or 10/30/60/300/900/3600)"),
    chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("toggle_slow_mode", p)),
);

server.tool(
  "get_admin_log",
  "View recent admin actions in a group (who changed what, when).",
  {
    limit: z.number().optional().describe("Number of log entries (default 20, max 100)"),
  },
  async (p) => textResult(await callBridge("get_admin_log", p)),
);

// ── Userbot: Messaging extras ────────────────────────────────────────────────

server.tool(
  "send_album",
  "Send a group of photos/videos as an album (up to 10 items).",
  {
    file_paths: z.array(z.string()).describe("Array of image/video file paths (2–10 files)"),
    caption: z.string().optional().describe("Caption for the album"),
  },
  async (p) => textResult(await callBridge("send_album", p)),
);

server.tool(
  "clear_reactions",
  "Remove all your reactions from a message.",
  { message_id: z.number().describe("Message ID") },
  async (p) => textResult(await callBridge("clear_reactions", p)),
);

server.tool(
  "mark_as_read",
  "Mark all messages in the current chat as read.",
  {},
  async () => textResult(await callBridge("mark_as_read", {})),
);

server.tool(
  "search_global",
  "Search for messages across ALL your chats (not just the current one).",
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (p) => textResult(await callBridge("search_global", p)),
);

server.tool(
  "translate_text",
  "Translate text to a target language using Telegram's built-in translation.",
  {
    text: z.string().describe("Text to translate"),
    to_lang: z.string().describe("Target language code (e.g. 'en', 'es', 'fr', 'de', 'ja', 'zh')"),
  },
  async (p) => textResult(await callBridge("translate_text", p)),
);

server.tool(
  "transcribe_audio",
  "Transcribe a voice message or audio file to text using Telegram's speech recognition.",
  { message_id: z.number().describe("Message ID of the voice/audio message to transcribe") },
  async (p) => textResult(await callBridge("transcribe_audio", p)),
);

server.tool(
  "get_message_reactions",
  "Get who reacted to a message and with which emoji.",
  { message_id: z.number().describe("Message ID") },
  async (p) => textResult(await callBridge("get_message_reactions", p)),
);

server.tool(
  "get_dialogs",
  "List all your chats, groups, channels, and DMs with unread counts and last message info.",
  {
    limit: z.number().optional().describe("Max number of dialogs to return (default 20)"),
    offset: z.number().optional().describe("Pagination offset"),
  },
  async (p) => textResult(await callBridge("get_dialogs", p)),
);

server.tool(
  "get_common_chats",
  "Find groups and channels you share with another user.",
  { user_id: z.number().describe("Telegram user ID") },
  async (p) => textResult(await callBridge("get_common_chats", p)),
);

// ── Userbot: Stories ─────────────────────────────────────────────────────────

server.tool(
  "post_story",
  "Post a story (photo or short video) visible to your contacts for 24h.",
  {
    file_path: z.string().describe("Path to photo (JPG/PNG) or video (MP4) file"),
    caption: z.string().optional().describe("Story caption text"),
    duration_seconds: z.number().optional().describe("Duration to show photo in story (default 7)"),
  },
  async (p) => textResult(await callBridge("post_story", p)),
);

server.tool(
  "delete_story",
  "Delete one of your stories.",
  { story_id: z.number().describe("Story ID to delete") },
  async (p) => textResult(await callBridge("delete_story", p)),
);

server.tool(
  "get_stories",
  "List active stories (yours or another user's).",
  { user_id: z.number().optional().describe("User ID to get stories for (defaults to your own)") },
  async (p) => textResult(await callBridge("get_stories", p)),
);

// ── Userbot: Forum topics ────────────────────────────────────────────────────

server.tool(
  "create_forum_topic",
  "Create a new topic in a forum-enabled supergroup.",
  {
    title: z.string().describe("Topic title"),
    icon_emoji: z.string().optional().describe("Icon emoji for the topic"),
  },
  async (p) => textResult(await callBridge("create_forum_topic", p)),
);

server.tool(
  "edit_forum_topic",
  "Edit a forum topic's title or icon.",
  {
    topic_id: z.number().describe("Topic/thread ID"),
    title: z.string().describe("New title"),
    icon_emoji: z.string().optional().describe("New icon emoji"),
  },
  async (p) => textResult(await callBridge("edit_forum_topic", p)),
);

// ── Invite links ─────────────────────────────────────────────────────────────

server.tool(
  "get_invite_link",
  "Get the primary invite link for a chat (defaults to current chat).",
  { chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("get_invite_link", p)),
);

server.tool(
  "create_invite_link",
  "Create a new invite link for a chat (defaults to current chat) with optional limits.",
  {
    chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)"),
    title: z.string().optional().describe("Label for this link"),
    expire_date: z.number().optional().describe("Unix timestamp when the link expires"),
    usage_limit: z.number().optional().describe("Max number of uses (0 = unlimited)"),
    request_needed: z.boolean().optional().describe("If true, users must be approved by admin before joining"),
  },
  async (p) => textResult(await callBridge("create_invite_link", p)),
);

server.tool(
  "revoke_invite_link",
  "Revoke an invite link so it can no longer be used.",
  {
    link: z.string().describe("The invite link to revoke"),
    chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("revoke_invite_link", p)),
);

server.tool(
  "get_invite_links",
  "List all active invite links for a chat (defaults to current chat).",
  { chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("get_invite_links", p)),
);

// ── Cross-chat operations ─────────────────────────────────────────────────────

server.tool(
  "read_any_chat",
  `Read messages from ANY chat Claudius is in — not just the current one.
Use to monitor channels, read another group, check DMs, etc.

Target: @username, numeric chat ID, or +phone.
Examples:
  read_any_chat(target="@durov", limit=10)
  read_any_chat(target="-1001234567890", limit=30, before="2026-01-01")`,
  {
    target: z.string().describe("@username, numeric chat ID, or +phone"),
    limit: z.number().optional().describe("Number of messages (default 20, max 100)"),
    before: z.string().optional().describe("ISO date — fetch messages before this date"),
  },
  async (p) => textResult(await callBridge("read_any_chat", p)),
);

server.tool(
  "forward_to",
  "Forward a message from the current chat to any other chat.",
  {
    message_id: z.number().describe("Message ID to forward"),
    to: z.string().describe("Destination: @username, numeric ID, etc."),
  },
  async (p) => textResult(await callBridge("forward_to", p)),
);

// ── Poll interaction ──────────────────────────────────────────────────────────

server.tool(
  "vote_poll",
  "Vote in a poll in the current chat.",
  {
    message_id: z.number().describe("Message ID of the poll"),
    option_index: z.number().describe("Zero-based index of the option to vote for"),
  },
  async (p) => textResult(await callBridge("vote_poll", p)),
);

// ── Dialog organisation ───────────────────────────────────────────────────────

server.tool(
  "pin_chat",
  "Pin or unpin a chat in the dialog list (defaults to current chat).",
  {
    chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)"),
    pinned: z.boolean().optional().describe("true to pin, false to unpin (default: true)"),
  },
  async (p) => textResult(await callBridge("pin_chat", p)),
);

server.tool(
  "archive_chat",
  "Archive or unarchive a chat (defaults to current chat).",
  {
    chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)"),
    archive: z.boolean().optional().describe("true to archive, false to unarchive (default: true)"),
  },
  async (p) => textResult(await callBridge("archive_chat", p)),
);

server.tool(
  "mute_chat",
  "Mute or unmute notifications for a chat (defaults to current chat).",
  {
    chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)"),
    muted: z.boolean().optional().describe("true to mute, false to unmute (default: true)"),
    duration_seconds: z.number().optional().describe("Mute for this many seconds (omit for indefinite)"),
  },
  async (p) => textResult(await callBridge("mute_chat", p)),
);

// ── Saved Messages ────────────────────────────────────────────────────────────

server.tool(
  "save_to_saved",
  "Save a message or text to Saved Messages (your personal Telegram notepad).",
  {
    chat_id: z.number().optional().describe("Chat ID to forward message from (defaults to current chat)"),
    message_id: z.number().optional().describe("Forward this message ID to Saved Messages"),
    text: z.string().optional().describe("Or save this text directly to Saved Messages"),
  },
  async (p) => textResult(await callBridge("save_to_saved", p)),
);

// ── Utilities ─────────────────────────────────────────────────────────────────

server.tool(
  "get_message_link",
  "Get a shareable t.me link to a specific message in a channel or supergroup.",
  {
    message_id: z.number().describe("Message ID"),
    chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("get_message_link", p)),
);

server.tool(
  "check_username",
  "Check whether a Telegram @username is available to use.",
  { username: z.string().describe("Username to check (with or without @)") },
  async (p) => textResult(await callBridge("check_username", p)),
);

server.tool(
  "get_full_user",
  "Get comprehensive profile info for any Telegram user: name, bio, phone, common chats, Premium/Verified status.",
  {
    target: z.string().describe("@username, +phone, or numeric user ID"),
  },
  async (p) => textResult(await callBridge("get_full_user", p)),
);

server.tool(
  "delete_messages_bulk",
  "Delete multiple messages at once by their IDs.",
  {
    message_ids: z.array(z.number()).describe("Array of message IDs to delete"),
    revoke: z.boolean().optional().describe("Also delete for everyone (default: true)"),
  },
  async (p) => textResult(await callBridge("delete_messages_bulk", p)),
);

// ── Privacy ───────────────────────────────────────────────────────────────────

server.tool(
  "get_privacy",
  "Get current privacy setting for a specific key.",
  {
    key: z.enum(["status_timestamp", "chat_invite", "phone_number", "phone_call", "phone_p2p", "forwards", "profile_photo", "about"])
      .optional().describe("Privacy key (default: status_timestamp / last seen)"),
  },
  async (p) => textResult(await callBridge("get_privacy", p)),
);

server.tool(
  "set_privacy",
  "Set a privacy rule for your account.",
  {
    key: z.enum(["status_timestamp", "chat_invite", "phone_number", "phone_call", "profile_photo", "forwards", "about"])
      .describe("Which setting to change"),
    rule: z.enum(["allow_all", "allow_contacts", "allow_close_friends", "disallow_all", "disallow_contacts"])
      .describe("Who can see/use this"),
  },
  async (p) => textResult(await callBridge("set_privacy", p)),
);

// ── Web ─────────────────────────────────────────────────────────────────────

server.tool(
  "web_search",
  "Search the web using SearXNG. Returns titles, URLs, and snippets. Use for current events, facts, or finding URLs to fetch.",
  {
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default 5, max 10)"),
  },
  async (params) => textResult(await callBridge("web_search", params)),
);

server.tool(
  "fetch_url",
  "Fetch a URL — web pages return text content, image URLs are downloaded to workspace. Use to read articles, download images, or fetch any URL.",
  {
    url: z.string().describe("The URL to fetch"),
  },
  async (params) => textResult(await callBridge("fetch_url", params)),
);

// ── Notes / persistent memory ─────────────────────────────────────────────────

server.tool(
  "save_note",
  `Save a persistent note to Claudius's long-term memory.
Notes survive restarts and are searchable. Use them to remember user preferences,
ongoing situations, people's details, tasks, anything worth keeping.

Examples:
  save_note(key="dylan_prefs", content="Prefers concise replies. Hates emojis.")
  save_note(key="project_status", content="Backend done, frontend in progress", tags=["work"])`,
  {
    key: z.string().describe("Unique key (letters, numbers, underscores, hyphens)"),
    content: z.string().describe("The content to save"),
    tags: z.array(z.string()).optional().describe("Optional tags for organisation"),
  },
  async (p) => textResult(await callBridge("save_note", p)),
);

server.tool(
  "get_note",
  "Retrieve a saved note by key.",
  { key: z.string().describe("Note key") },
  async (p) => textResult(await callBridge("get_note", p)),
);

server.tool(
  "list_notes",
  "List all saved notes (optionally filtered by tag).",
  { tag: z.string().optional().describe("Filter by this tag") },
  async (p) => textResult(await callBridge("list_notes", p)),
);

server.tool(
  "delete_note",
  "Delete a saved note.",
  { key: z.string().describe("Note key to delete") },
  async (p) => textResult(await callBridge("delete_note", p)),
);

server.tool(
  "search_notes",
  "Search through all saved notes by keyword.",
  { query: z.string().describe("Search term") },
  async (p) => textResult(await callBridge("search_notes", p)),
);

// ── Situational awareness ─────────────────────────────────────────────────────

server.tool(
  "get_online_status",
  "Check when a user was last online / if they are currently online.",
  { user_id: z.number().describe("User ID to check") },
  async (p) => textResult(await callBridge("get_online_status", p)),
);

server.tool(
  "get_unread_counts",
  `Get all chats with unread messages, sorted by unread count.
Use to prioritise attention across conversations.`,
  { limit: z.number().optional().describe("Max dialogs to scan (default 100)") },
  async (p) => textResult(await callBridge("get_unread_counts", p)),
);

server.tool(
  "get_chat_activity",
  "Get message frequency per member for a chat — who's most active.",
  {
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    limit: z.number().optional().describe("Number of recent messages to analyse (default 200, max 500)"),
  },
  async (p) => textResult(await callBridge("get_chat_activity", p)),
);

// ── Drafts ────────────────────────────────────────────────────────────────────

server.tool(
  "get_draft",
  "Get the current draft message for a chat.",
  { chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("get_draft", p)),
);

server.tool(
  "set_draft",
  "Save a draft message in a chat (visible in Telegram app as a pending draft).",
  {
    text: z.string().describe("Draft text"),
    chat_id: z.number().optional().describe("Target chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_draft", p)),
);

// ── Broadcast ─────────────────────────────────────────────────────────────────

server.tool(
  "broadcast",
  `Send the same message to multiple chats at once.
Use for announcements, mass notifications, or reaching multiple people.

Example: broadcast(text="Meeting in 5!", targets=[123456789, -1001234567890, "@somegroup"])`,
  {
    text: z.string().describe("Message text to send"),
    targets: z.array(z.union([z.number(), z.string()])).describe("List of chat IDs or @usernames to send to"),
  },
  async (p) => textResult(await callBridge("broadcast", p)),
);

// ── Keyword watches ───────────────────────────────────────────────────────────

server.tool(
  "watch_keyword",
  `Watch for a keyword across all chats (or a specific chat). When a message contains
the keyword, Claudius will proactively respond to it even in groups where not @mentioned.

Examples:
  watch_keyword(keyword="urgent")          — alert on "urgent" in any chat
  watch_keyword(keyword="bug", chat_id=-1001234567890) — only in that group`,
  {
    keyword: z.string().describe("Keyword or phrase to watch for (case-insensitive)"),
    chat_id: z.number().optional().describe("Restrict to this chat ID (omit for all chats)"),
  },
  async (p) => textResult(await callBridge("watch_keyword", p)),
);

server.tool(
  "unwatch_keyword",
  "Stop watching for a keyword.",
  { keyword: z.string().describe("Keyword to stop watching") },
  async (p) => textResult(await callBridge("unwatch_keyword", p)),
);

server.tool(
  "list_watches",
  "List all active keyword watches.",
  {},
  async () => textResult(await callBridge("list_watches", {})),
);

// ── Join requests ─────────────────────────────────────────────────────────────

server.tool(
  "get_join_requests",
  "List pending join requests for a chat.",
  {
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (p) => textResult(await callBridge("get_join_requests", p)),
);

server.tool(
  "approve_join_request",
  "Approve a pending join request.",
  {
    user_id: z.number().describe("User ID to approve"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("approve_join_request", p)),
);

server.tool(
  "decline_join_request",
  "Decline a pending join request.",
  {
    user_id: z.number().describe("User ID to decline"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("decline_join_request", p)),
);

// ── Chat settings ─────────────────────────────────────────────────────────────

server.tool(
  "set_auto_delete",
  "Set message auto-delete timer for a chat. Messages are deleted after the specified duration.",
  {
    seconds: z.number().describe("TTL in seconds: 0=off, 86400=1day, 604800=1week, 2592000=1month"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_auto_delete", p)),
);

server.tool(
  "set_protected_content",
  "Toggle forwarding/saving restriction on a chat's content.",
  {
    enabled: z.boolean().describe("true to restrict forwarding, false to allow"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_protected_content", p)),
);

server.tool(
  "convert_to_supergroup",
  "Convert a basic group to a supergroup (enables admin features, topics, etc).",
  { chat_id: z.number().optional().describe("Basic group chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("convert_to_supergroup", p)),
);

// ── Entity lookup ─────────────────────────────────────────────────────────────

server.tool(
  "resolve_peer",
  "Resolve any @username, phone number, or ID to full entity info.",
  { query: z.string().describe("@username, +phone, or numeric ID") },
  async (p) => textResult(await callBridge("resolve_peer", p)),
);

// ── Scheduled messages ────────────────────────────────────────────────────────

server.tool(
  "get_scheduled_messages",
  "List all server-side scheduled messages in a chat.",
  { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("get_scheduled_messages", p)),
);

server.tool(
  "delete_scheduled_message",
  "Delete a scheduled message before it sends.",
  {
    message_id: z.number().describe("Scheduled message ID to cancel"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("delete_scheduled_message", p)),
);

// ── Forum topics ──────────────────────────────────────────────────────────────

server.tool(
  "close_forum_topic",
  "Close a forum topic (archive it).",
  {
    topic_id: z.number().describe("Topic ID to close"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("close_forum_topic", p)),
);

server.tool(
  "reopen_forum_topic",
  "Reopen a closed forum topic.",
  {
    topic_id: z.number().describe("Topic ID to reopen"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("reopen_forum_topic", p)),
);

server.tool(
  "delete_forum_topic",
  "Delete a forum topic and all its messages.",
  {
    topic_id: z.number().describe("Topic ID to delete"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("delete_forum_topic", p)),
);

// ── Channel management ────────────────────────────────────────────────────────

server.tool(
  "set_channel_username",
  "Set or remove the public @username for a channel/supergroup.",
  {
    username: z.string().describe("New username (without @), or empty string to remove"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_channel_username", p)),
);

server.tool(
  "set_discussion_group",
  "Link a discussion supergroup to a channel.",
  {
    group_id: z.number().describe("Supergroup ID to use as discussion group"),
    channel_id: z.number().optional().describe("Channel ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_discussion_group", p)),
);

// ── Emoji status ──────────────────────────────────────────────────────────────

server.tool(
  "set_emoji_status",
  "Set or clear your profile emoji status (the icon next to your name).",
  {
    document_id: z.string().optional().describe("Custom emoji document ID (omit to clear)"),
    until: z.number().optional().describe("Unix timestamp when status expires (omit for permanent)"),
  },
  async (p) => textResult(await callBridge("set_emoji_status", p)),
);

server.tool(
  "get_emoji_status",
  "Get your current emoji status.",
  {},
  async () => textResult(await callBridge("get_emoji_status", {})),
);

// ── Discovery & stats ─────────────────────────────────────────────────────────

server.tool(
  "get_similar_channels",
  "Find channels similar to a given channel.",
  { chat_id: z.number().optional().describe("Channel ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("get_similar_channels", p)),
);

server.tool(
  "get_channel_stats",
  "Get statistics for a channel or supergroup (views, growth, engagement).",
  { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("get_channel_stats", p)),
);

// ── Read management ───────────────────────────────────────────────────────────

server.tool(
  "mark_mentions_read",
  "Mark all @mentions as read in a chat.",
  { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("mark_mentions_read", p)),
);

server.tool(
  "mark_reactions_read",
  "Mark all reaction notifications as read in a chat.",
  { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("mark_reactions_read", p)),
);

// ── Message context ───────────────────────────────────────────────────────────

server.tool(
  "get_message_context",
  "Get messages surrounding a specific message (before and after it).",
  {
    message_id: z.number().describe("Center message ID"),
    context_size: z.number().optional().describe("Messages each side (default 5)"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("get_message_context", p)),
);

// ── Poll ──────────────────────────────────────────────────────────────────────

server.tool(
  "get_poll_results",
  "Get detailed vote breakdown for a poll.",
  {
    message_id: z.number().describe("Poll message ID"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("get_poll_results", p)),
);

// ── Media listing ─────────────────────────────────────────────────────────────

server.tool(
  "list_media",
  "Search for media files in a chat.",
  {
    type: z.enum(["photo", "video", "document", "voice", "all"]).optional().describe("Media type (default: all)"),
    limit: z.number().optional().describe("Max results (default 20)"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("list_media", p)),
);

// ── Contacts ──────────────────────────────────────────────────────────────────

server.tool(
  "get_mutual_contacts",
  "Get contacts who are also your Telegram contacts (mutual).",
  {},
  async () => textResult(await callBridge("get_mutual_contacts", {})),
);

server.tool(
  "import_contacts",
  "Import multiple phone contacts at once.",
  {
    contacts: z.array(z.object({
      phone: z.string().describe("Phone number with country code"),
      first_name: z.string().describe("First name"),
      last_name: z.string().optional().describe("Last name"),
    })).describe("Array of contacts to import"),
  },
  async (p) => textResult(await callBridge("import_contacts", p)),
);

// ── Reactions & read receipts ─────────────────────────────────────────────────

server.tool(
  "get_reactions_available",
  "List all reactions available for use in a chat.",
  { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
  async (p) => textResult(await callBridge("get_reactions_available", p)),
);

server.tool(
  "get_read_participants",
  "See who has read a specific message in a group.",
  {
    message_id: z.number().describe("Message ID"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("get_read_participants", p)),
);

// ── Bulk operations ───────────────────────────────────────────────────────────

server.tool(
  "clear_chat_history",
  "Delete all messages in a chat (local or both sides).",
  {
    revoke: z.boolean().optional().describe("true to delete for both sides (DMs only), false for local only"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("clear_chat_history", p)),
);

server.tool(
  "forward_messages_bulk",
  "Forward multiple messages at once to another chat.",
  {
    message_ids: z.array(z.number()).describe("Array of message IDs to forward"),
    to: z.string().describe("Destination: @username, numeric ID, etc."),
    from_chat_id: z.number().optional().describe("Source chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("forward_messages_bulk", p)),
);

// ── Profile photos ────────────────────────────────────────────────────────────

server.tool(
  "get_profile_photos",
  "Get a user's profile photos.",
  {
    user_id: z.number().optional().describe("User ID (defaults to self)"),
    limit: z.number().optional().describe("Max photos (default 10)"),
  },
  async (p) => textResult(await callBridge("get_profile_photos", p)),
);

// ── Connection ────────────────────────────────────────────────────────────────

server.tool(
  "get_connection_status",
  "Check the userbot connection status and session info.",
  {},
  async () => textResult(await callBridge("get_connection_status", {})),
);

// ── Poll & vote tools ─────────────────────────────────────────────────────────

server.tool(
  "retract_vote",
  "Retract your vote from a poll.",
  {
    message_id: z.number().describe("Message ID of the poll"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("retract_vote", p)),
);

// ── Scheduled messages ────────────────────────────────────────────────────────

server.tool(
  "send_scheduled",
  "Send a message scheduled for a future time (server-side scheduling).",
  {
    text: z.string().describe("Message text"),
    send_at: z.union([z.number(), z.string()]).describe("When to send: unix timestamp (seconds) or ISO date string"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("send_scheduled", p)),
);

// ── Message replies & views ───────────────────────────────────────────────────

server.tool(
  "get_message_replies",
  "Get the reply thread for a specific message.",
  {
    message_id: z.number().describe("Message ID to get replies for"),
    limit: z.number().optional().describe("Max replies to return (default 20, max 100)"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("get_message_replies", p)),
);

server.tool(
  "get_message_views",
  "Get view/forward counts for channel messages.",
  {
    message_id: z.union([z.number(), z.array(z.number())]).describe("Message ID or array of IDs"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("get_message_views", p)),
);

// ── Location & spam ───────────────────────────────────────────────────────────

server.tool(
  "get_nearby_users",
  "Find Telegram users and groups near a geographic location.",
  {
    latitude: z.number().describe("Latitude"),
    longitude: z.number().describe("Longitude"),
    accuracy: z.number().optional().describe("Accuracy in meters"),
  },
  async (p) => textResult(await callBridge("get_nearby_users", p)),
);

server.tool(
  "report_spam",
  "Report a user or chat as spam.",
  {
    user_id: z.number().optional().describe("User ID to report"),
    chat_id: z.number().optional().describe("Chat ID to report (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("report_spam", p)),
);

// ── Web preview ───────────────────────────────────────────────────────────────

server.tool(
  "get_web_page_preview",
  "Get link preview data (title, description, photo) without sending a message.",
  {
    url: z.string().describe("URL to preview"),
  },
  async (p) => textResult(await callBridge("get_web_page_preview", p)),
);

// ── Premium & translation ─────────────────────────────────────────────────────

server.tool(
  "get_premium_info",
  "Check if a user has Telegram Premium.",
  {
    user_id: z.number().optional().describe("User ID to check (defaults to self)"),
  },
  async (p) => textResult(await callBridge("get_premium_info", p)),
);

server.tool(
  "translate_message",
  "Translate a message using Telegram's built-in translation.",
  {
    message_id: z.number().describe("Message ID to translate"),
    to_lang: z.string().optional().describe("Target language code, e.g. 'en', 'es', 'fr' (default 'en')"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("translate_message", p)),
);

server.tool(
  "set_chat_color",
  "Set the accent color/theme of a channel or supergroup.",
  {
    color: z.number().describe("Color ID (0-6)"),
    background_emoji_id: z.string().optional().describe("Background emoji ID (bigint as string)"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_chat_color", p)),
);

// ── Advanced search ───────────────────────────────────────────────────────────

server.tool(
  "search_by_date",
  "Search messages within a specific date range.",
  {
    query: z.string().optional().describe("Search query (empty for all messages)"),
    from_date: z.string().optional().describe("Start date (ISO format)"),
    to_date: z.string().optional().describe("End date (ISO format)"),
    limit: z.number().optional().describe("Max results (default 50, max 200)"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("search_by_date", p)),
);

server.tool(
  "search_messages_from_user",
  "Search messages sent by a specific user in a chat.",
  {
    user_id: z.number().describe("User ID whose messages to search"),
    query: z.string().optional().describe("Search query (empty for all messages)"),
    limit: z.number().optional().describe("Max results (default 50, max 200)"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("search_messages_from_user", p)),
);

server.tool(
  "count_messages",
  "Count total messages in a chat.",
  {
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("count_messages", p)),
);

// ── Sticker discovery ─────────────────────────────────────────────────────────

server.tool(
  "search_stickers",
  "Search for sticker packs by keyword.",
  {
    query: z.string().describe("Search query"),
  },
  async (p) => textResult(await callBridge("search_stickers", p)),
);

server.tool(
  "get_trending_stickers",
  "Get trending/featured sticker packs.",
  {},
  async () => textResult(await callBridge("get_trending_stickers", {})),
);

server.tool(
  "get_recent_stickers",
  "Get recently used stickers.",
  {},
  async () => textResult(await callBridge("get_recent_stickers", {})),
);

// ── Privacy & security ────────────────────────────────────────────────────────

server.tool(
  "get_active_sessions",
  "List all active login sessions (devices, IPs, last active times).",
  {},
  async () => textResult(await callBridge("get_active_sessions", {})),
);

server.tool(
  "terminate_session",
  "Log out from another device/session.",
  {
    hash: z.string().describe("Session hash from get_active_sessions"),
  },
  async (p) => textResult(await callBridge("terminate_session", p)),
);

server.tool(
  "get_two_factor_status",
  "Check if two-factor authentication (2FA) is enabled.",
  {},
  async () => textResult(await callBridge("get_two_factor_status", {})),
);

// ── Contacts export ───────────────────────────────────────────────────────────

server.tool(
  "export_contacts",
  "Export all Telegram contacts as a vCard (.vcf) file.",
  {},
  async () => textResult(await callBridge("export_contacts", {})),
);

// ── Bot info ──────────────────────────────────────────────────────────────────

server.tool(
  "get_bot_info",
  "Get detailed info about a Telegram bot (description, commands list).",
  {
    user_id: z.number().optional().describe("Bot user ID"),
    username: z.string().optional().describe("Bot @username"),
  },
  async (p) => textResult(await callBridge("get_bot_info", p)),
);

// ── Invite link preview ──────────────────────────────────────────────────────

server.tool(
  "get_chat_invite_link_info",
  "Preview an invite link without joining — see chat title, member count, etc.",
  {
    hash: z.string().describe("Invite link hash or full t.me link"),
  },
  async (p) => textResult(await callBridge("get_chat_invite_link_info", p)),
);

// ── Send-as identity ──────────────────────────────────────────────────────────

server.tool(
  "set_default_send_as",
  "Set who messages are sent as in a channel (your account or a channel you admin).",
  {
    send_as: z.number().describe("User ID or channel ID to send as"),
    chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
  },
  async (p) => textResult(await callBridge("set_default_send_as", p)),
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
