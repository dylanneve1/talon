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

// ── Start ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
