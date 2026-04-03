/**
 * Shared tools — work with both bot and userbot frontends.
 */

import { z, callBridge, textResult, type ToolServer } from "./bridge.js";

export function registerSharedTools(server: ToolServer): void {
  // ── Unified send tool ──────────────────────────────────────────────────────

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
      emoji: z.string().optional().describe("Dice emoji (\u{1F3B2}\u{1F3AF}\u{1F3C0}\u26BD\u{1F3B3}\u{1F3B0})"),
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
    `Send a message to ANY Telegram user, group, or channel \u2014 not just the current chat.
Use this to slide into someone's DMs, message a contact, or post to another group.

Target formats:
  @username    \u2192 send by Telegram username
  +12125551234 \u2192 send by phone number (must be a contact)
  352042062    \u2192 send by numeric Telegram user/chat ID

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
    "Add an emoji reaction to a message. Valid: \u{1F44D} \u{1F44E} \u2764 \u{1F525} \u{1F970} \u{1F44F} \u{1F601} \u{1F914} \u{1F92F} \u{1F631} \u{1F92C} \u{1F622} \u{1F389} \u{1F929} \u{1F92E} \u{1F4A9} \u{1F64F} \u{1F44C} \u{1F54A} \u{1F921} \u{1F971} \u{1F974} \u{1F60D} \u{1F433} \u2764\u200D\u{1F525} \u{1F31A} \u{1F32D} \u{1F4AF} \u{1F923} \u26A1 \u{1F34C} \u{1F3C6} \u{1F494} \u{1F928} \u{1F610} \u{1F353} \u{1F37E} \u{1F48B} \u{1F595} \u{1F608} \u{1F634} \u{1F62D} \u{1F913} \u{1F47B} \u{1F468}\u200D\u{1F4BB} \u{1F440} \u{1F383} \u{1F648} \u{1F607} \u{1F628} \u{1F91D} \u270D \u{1F917} \u{1FAE1} \u{1F385} \u{1F384} \u2603 \u{1F485} \u{1F92A} \u{1F5FF} \u{1F196} \u{1F498} \u{1F649} \u{1F984} \u{1F618} \u{1F48A} \u{1F64A} \u{1F60E} \u{1F47E} \u{1F937} \u{1F937}\u200D\u2642 \u{1F937}\u200D\u2640 \u{1F621}",
    {
      message_id: z.number().describe("Message ID"),
      emoji: z.string().describe("Reaction emoji"),
    },
    async (params) => textResult(await callBridge("react", params)),
  );

  server.tool(
    "clear_reactions",
    "Remove all your reactions from a message.",
    { message_id: z.number().describe("Message ID") },
    async (p) => textResult(await callBridge("clear_reactions", p)),
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
    "copy_message",
    "Copy a message to the current chat (without forward header).",
    { message_id: z.number() },
    async (params) => textResult(await callBridge("copy_message", params)),
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
    "send_chat_action",
    "Show a chat action like 'typing...', 'uploading photo', etc.",
    {
      action: z.enum(["typing", "upload_photo", "record_video", "upload_video", "record_voice", "upload_voice", "upload_document", "find_location", "record_video_note", "upload_video_note", "choose_sticker", "playing"])
        .describe("Chat action to show"),
    },
    async (p) => textResult(await callBridge("send_chat_action", p)),
  );

  server.tool(
    "schedule_message",
    "Schedule a message for delayed delivery.",
    {
      text: z.string().describe("Message text"),
      delay_seconds: z.number().describe("Delay in seconds (1-3600)"),
    },
    async (p) => textResult(await callBridge("schedule_message", p)),
  );

  server.tool(
    "cancel_scheduled",
    "Cancel a scheduled message.",
    { schedule_id: z.string() },
    async (params) => textResult(await callBridge("cancel_scheduled", params)),
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
    "search_global",
    "Search for messages across ALL your chats (not just the current one).",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async (p) => textResult(await callBridge("search_global", p)),
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
    "get_pinned_messages",
    "Get all pinned messages in the current chat.",
    {},
    async () => textResult(await callBridge("get_pinned_messages", {})),
  );

  // ── Media ────────────────────────────────────────────────────────────────────

  server.tool(
    "download_media",
    "Download a photo, document, or other media from a message by its ID. Saves the file to the workspace and returns the file path so you can read/analyze it. Use this when you see a [photo] or [document] in chat history but don't have the file.",
    {
      message_id: z.number().describe("Message ID containing the media to download"),
    },
    async (params) => textResult(await callBridge("download_media", params)),
  );

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

  server.tool(
    "mark_as_read",
    "Mark all messages in the current chat as read.",
    {},
    async () => textResult(await callBridge("mark_as_read", {})),
  );

  // ── Translation & transcription ──────────────────────────────────────────────

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

  // ── Reactions & analytics ────────────────────────────────────────────────────

  server.tool(
    "get_message_reactions",
    "Get who reacted to a message and with which emoji.",
    { message_id: z.number().describe("Message ID") },
    async (p) => textResult(await callBridge("get_message_reactions", p)),
  );

  server.tool(
    "get_common_chats",
    "Find groups and channels you share with another user.",
    { user_id: z.number().describe("Telegram user ID") },
    async (p) => textResult(await callBridge("get_common_chats", p)),
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

  server.tool(
    "online_count",
    "Get how many members are currently online or recently active.",
    {},
    async () => textResult(await callBridge("online_count", {})),
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

  server.tool(
    "set_chat_photo",
    "Set a new photo for a group or channel.",
    {
      file_path: z.string().describe("Path to the image file"),
      chat_id: z.number().optional().describe("Target chat (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("set_chat_photo", p)),
  );

  // ── Chat lifecycle ───────────────────────────────────────────────────────────

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

  // ── Member management ────────────────────────────────────────────────────────

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

  // ── Stickers ─────────────────────────────────────────────────────────────────

  server.tool(
    "get_sticker_pack",
    "Get all stickers in a sticker pack by its name. Returns emoji + file_id for each sticker so you can send them. Use when you see a sticker set name in chat history.",
    {
      set_name: z.string().describe("Sticker set name (e.g. 'AnimatedEmojies' or from sticker metadata)"),
    },
    async (params) => textResult(await callBridge("get_sticker_pack", params)),
  );

  server.tool(
    "save_sticker_pack",
    "Save a sticker pack's file_ids to workspace for quick reuse. Once saved, you can read the JSON file to find stickers by emoji and send them instantly.",
    {
      set_name: z.string().describe("Sticker set name"),
    },
    async (params) => textResult(await callBridge("save_sticker_pack", params)),
  );

  server.tool(
    "download_sticker",
    "Download a sticker image to workspace so you can view its contents. Returns the file path.",
    {
      file_id: z.string().describe("Sticker file_id from chat history or sticker pack listing"),
    },
    async (params) => textResult(await callBridge("download_sticker", params)),
  );

  // ── Forum topics ─────────────────────────────────────────────────────────────

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

  // ── Dialog organisation ──────────────────────────────────────────────────────

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

  // ── Utilities ────────────────────────────────────────────────────────────────

  server.tool(
    "check_username",
    "Check whether a Telegram @username is available to use.",
    { username: z.string().describe("Username to check (with or without @)") },
    async (p) => textResult(await callBridge("check_username", p)),
  );

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
    "delete_messages_bulk",
    "Delete multiple messages at once by their IDs.",
    {
      message_ids: z.array(z.number()).describe("Array of message IDs to delete"),
      revoke: z.boolean().optional().describe("Also delete for everyone (default: true)"),
    },
    async (p) => textResult(await callBridge("delete_messages_bulk", p)),
  );

  // ── Join requests ────────────────────────────────────────────────────────────

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

  // ── Read management ──────────────────────────────────────────────────────────

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

  // ── Message context & views ──────────────────────────────────────────────────

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

  // ── Polls ────────────────────────────────────────────────────────────────────

  server.tool(
    "get_poll_results",
    "Get detailed vote breakdown for a poll.",
    {
      message_id: z.number().describe("Poll message ID"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("get_poll_results", p)),
  );

  server.tool(
    "count_messages",
    "Count total messages in a chat.",
    {
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("count_messages", p)),
  );

  server.tool(
    "vote_poll",
    "Vote in a poll in the current chat.",
    {
      message_id: z.number().describe("Message ID of the poll"),
      option_index: z.number().describe("Zero-based index of the option to vote for"),
    },
    async (p) => textResult(await callBridge("vote_poll", p)),
  );

  server.tool(
    "stop_poll",
    "Stop an active poll and get the final results. Returns vote counts for each option.",
    { message_id: z.number().describe("Message ID of the poll to stop") },
    async (params) => textResult(await callBridge("stop_poll", params)),
  );

  server.tool(
    "retract_vote",
    "Retract your vote from a poll.",
    {
      message_id: z.number().describe("Message ID of the poll"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("retract_vote", p)),
  );

  // ── Advanced search ──────────────────────────────────────────────────────────

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

  // ── Reactions & read receipts ────────────────────────────────────────────────

  server.tool(
    "get_read_participants",
    "See who has read a specific message in a group.",
    {
      message_id: z.number().describe("Message ID"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("get_read_participants", p)),
  );

  server.tool(
    "get_reactions_available",
    "List all reactions available for use in a chat.",
    { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
    async (p) => textResult(await callBridge("get_reactions_available", p)),
  );

  // ── Chat settings ────────────────────────────────────────────────────────────

  server.tool(
    "get_notification_settings",
    "Get notification settings for a chat (muted, previews, sound).",
    { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
    async (p) => textResult(await callBridge("get_notification_settings", p)),
  );

  server.tool(
    "get_chat_permissions",
    "Get default permissions for a chat (what members can/can't do).",
    { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
    async (p) => textResult(await callBridge("get_chat_permissions", p)),
  );

  server.tool(
    "set_chat_permissions",
    "Set default permissions for all members in a chat.",
    {
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
      send_messages: z.boolean().optional().describe("Allow sending messages"),
      send_media: z.boolean().optional().describe("Allow sending media"),
      send_stickers: z.boolean().optional().describe("Allow stickers/GIFs"),
      send_polls: z.boolean().optional().describe("Allow polls"),
      change_info: z.boolean().optional().describe("Allow changing chat info"),
      invite_users: z.boolean().optional().describe("Allow inviting users"),
      pin_messages: z.boolean().optional().describe("Allow pinning messages"),
    },
    async (p) => textResult(await callBridge("set_chat_permissions", p)),
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

  server.tool(
    "get_bot_info",
    "Get detailed info about a Telegram bot (description, commands list).",
    {
      user_id: z.number().optional().describe("Bot user ID"),
      username: z.string().optional().describe("Bot @username"),
    },
    async (p) => textResult(await callBridge("get_bot_info", p)),
  );

  server.tool(
    "get_chat_invite_link_info",
    "Preview an invite link without joining \u2014 see chat title, member count, etc.",
    {
      hash: z.string().describe("Invite link hash or full t.me link"),
    },
    async (p) => textResult(await callBridge("get_chat_invite_link_info", p)),
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

  // ── Send album ───────────────────────────────────────────────────────────────

  server.tool(
    "send_album",
    "Send a group of photos/videos as an album (up to 10 items).",
    {
      file_paths: z.array(z.string()).describe("Array of image/video file paths (2\u201310 files)"),
      caption: z.string().optional().describe("Caption for the album"),
    },
    async (p) => textResult(await callBridge("send_album", p)),
  );

  // ── Notes / persistent memory ──────────────────────────────────────────────────

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

  // ── Keyword watches ──────────────────────────────────────────────────────────

  server.tool(
    "watch_keyword",
    `Watch for a keyword across all chats (or a specific chat). When a message contains
the keyword, Claudius will proactively respond to it even in groups where not @mentioned.

Examples:
  watch_keyword(keyword="urgent")          \u2014 alert on "urgent" in any chat
  watch_keyword(keyword="bug", chat_id=-1001234567890) \u2014 only in that group`,
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

  // ── Web ──────────────────────────────────────────────────────────────────────

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
    "Fetch a URL \u2014 web pages return text content, image URLs are downloaded to workspace. Use to read articles, download images, or fetch any URL.",
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
}
