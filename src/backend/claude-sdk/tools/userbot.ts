/**
 * Userbot-only tools — require MTProto user session (not available in bot mode).
 */

import { z, callBridge, textResult, type ToolServer } from "./bridge.js";

export function registerUserbotTools(server: ToolServer): void {
  // ── Profile management ───────────────────────────────────────────────────────

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

  server.tool(
    "get_profile_photos",
    "Get a user's profile photos.",
    {
      user_id: z.number().optional().describe("User ID (defaults to self)"),
      limit: z.number().optional().describe("Max photos (default 10)"),
    },
    async (p) => textResult(await callBridge("get_profile_photos", p)),
  );

  // ── Contacts ─────────────────────────────────────────────────────────────────

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

  server.tool(
    "get_mutual_contacts",
    "Get contacts who are also your Telegram contacts (mutual).",
    {},
    async () => textResult(await callBridge("get_mutual_contacts", {})),
  );

  server.tool(
    "export_contacts",
    "Export all Telegram contacts as a vCard (.vcf) file.",
    {},
    async () => textResult(await callBridge("export_contacts", {})),
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

  // ── Stories ──────────────────────────────────────────────────────────────────

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

  server.tool(
    "get_story_viewers",
    "See who viewed one of your stories (with reactions).",
    {
      story_id: z.number().describe("Story ID"),
      limit: z.number().optional().describe("Max viewers (default 50)"),
    },
    async (p) => textResult(await callBridge("get_story_viewers", p)),
  );

  // ── Privacy & security ───────────────────────────────────────────────────────

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

  // ── Cross-chat operations ────────────────────────────────────────────────────

  server.tool(
    "send_to_chat",
    `Send a message to any chat by ID or username (same as message_user bridge action, but explicit tool).`,
    {
      to: z.string().describe("Target: @username, +phone, or numeric chat/user ID"),
      text: z.string().optional().describe("Message text"),
      type: z.enum(["text", "photo", "file", "video", "voice"]).optional().describe("Content type (default: text)"),
      file_path: z.string().optional().describe("File path for media"),
      caption: z.string().optional().describe("Caption for media"),
    },
    async (p) => textResult(await callBridge("send_to_chat", p)),
  );

  server.tool(
    "read_any_chat",
    `Read messages from ANY chat Claudius is in \u2014 not just the current one.
Use to monitor channels, read another group, check DMs, etc.

Target: @username, numeric chat ID, or +phone.
Examples:
  read_any_chat(target="@durov", limit=10)
  read_any_chat(target="-1001234567890", limit=30, before="2026-01-01")`,
    {
      target: z.string().describe("@username, numeric chat ID, or +phone"),
      limit: z.number().optional().describe("Number of messages (default 20, max 100)"),
      before: z.string().optional().describe("ISO date \u2014 fetch messages before this date"),
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

  // ── Awareness ────────────────────────────────────────────────────────────────

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
    "Get message frequency per member for a chat \u2014 who's most active.",
    {
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
      limit: z.number().optional().describe("Number of recent messages to analyse (default 200, max 500)"),
    },
    async (p) => textResult(await callBridge("get_chat_activity", p)),
  );

  server.tool(
    "get_chat_summary",
    "Get a statistical summary of recent chat activity (senders, media count, time range).",
    {
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
      limit: z.number().optional().describe("Messages to analyze (default 100, max 500)"),
    },
    async (p) => textResult(await callBridge("get_chat_summary", p)),
  );

  server.tool(
    "get_user_activity_summary",
    "Track a user's recent activity across shared chats (last 7 days).",
    { user_id: z.number().describe("User ID to track") },
    async (p) => textResult(await callBridge("get_user_activity_summary", p)),
  );

  server.tool(
    "get_connection_status",
    "Check the userbot connection status and session info.",
    {},
    async () => textResult(await callBridge("get_connection_status", {})),
  );

  // ── Drafts ───────────────────────────────────────────────────────────────────

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

  // ── Discovery ────────────────────────────────────────────────────────────────

  server.tool(
    "resolve_peer",
    "Resolve any @username, phone number, or ID to full entity info.",
    { query: z.string().describe("@username, +phone, or numeric ID") },
    async (p) => textResult(await callBridge("resolve_peer", p)),
  );

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
    "get_nearby_chats",
    "Find groups and channels near a location.",
    {
      latitude: z.number().describe("Latitude"),
      longitude: z.number().describe("Longitude"),
    },
    async (p) => textResult(await callBridge("get_nearby_chats", p)),
  );

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

  server.tool(
    "get_premium_info",
    "Check if a user has Telegram Premium.",
    {
      user_id: z.number().optional().describe("User ID to check (defaults to self)"),
    },
    async (p) => textResult(await callBridge("get_premium_info", p)),
  );

  // ── Chat management (advanced) ───────────────────────────────────────────────

  server.tool(
    "convert_to_supergroup",
    "Convert a basic group to a supergroup (enables admin features, topics, etc).",
    { chat_id: z.number().optional().describe("Basic group chat ID (defaults to current chat)") },
    async (p) => textResult(await callBridge("convert_to_supergroup", p)),
  );

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
    "set_auto_delete",
    "Set message auto-delete timer for a chat. Messages are deleted after the specified duration.",
    {
      seconds: z.number().describe("TTL in seconds: 0=off, 86400=1day, 604800=1week, 2592000=1month"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("set_auto_delete", p)),
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

  server.tool(
    "set_default_send_as",
    "Set who messages are sent as in a channel (your account or a channel you admin).",
    {
      send_as: z.number().describe("User ID or channel ID to send as"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("set_default_send_as", p)),
  );

  server.tool(
    "get_full_chat_info",
    "Get comprehensive info about a chat or user (about, members, linked chat, slowmode, etc).",
    { chat_id: z.number().optional().describe("Chat/user ID (defaults to current chat)") },
    async (p) => textResult(await callBridge("get_full_chat_info", p)),
  );

  server.tool(
    "clear_chat_history",
    "Delete all messages in a chat (local or both sides).",
    {
      revoke: z.boolean().optional().describe("true to delete for both sides (DMs only), false for local only"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("clear_chat_history", p)),
  );

  // ── Forum (advanced) ────────────────────────────────────────────────────────

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

  server.tool(
    "get_forum_topics",
    "List all topics in a forum-enabled supergroup.",
    {
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
      limit: z.number().optional().describe("Max topics (default 50)"),
      query: z.string().optional().describe("Search topics by title"),
    },
    async (p) => textResult(await callBridge("get_forum_topics", p)),
  );

  server.tool(
    "send_to_topic",
    "Send a message to a specific forum topic.",
    {
      text: z.string().describe("Message text"),
      topic_id: z.number().describe("Topic ID"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("send_to_topic", p)),
  );

  // ── Stickers (advanced) ──────────────────────────────────────────────────────

  server.tool(
    "create_sticker_set",
    `Create a new sticker pack owned by a user. The bot will be the creator.
Sticker images must be PNG/WEBP, max 512x512px for static stickers.
The set name will automatically get "_by_<botname>" appended if needed.

Example: create_sticker_set(user_id=123, name="cool_pack", title="Cool Stickers", file_path="/path/to/sticker.png", emoji_list=["\u{1F60E}"])`,
    {
      user_id: z.number().describe("Telegram user ID who will own the pack"),
      name: z.string().describe("Short name for the pack (a-z, 0-9, underscores). Will get _by_<botname> appended."),
      title: z.string().describe("Display title for the pack (1-64 chars)"),
      file_path: z.string().describe("Path to the sticker image file (PNG/WEBP, 512x512 max)"),
      emoji_list: z.array(z.string()).optional().describe("Emojis for this sticker (default: ['\u{1F3A8}'])"),
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
      emoji_list: z.array(z.string()).optional().describe("Emojis for this sticker (default: ['\u{1F3A8}'])"),
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

  server.tool(
    "get_custom_emojis",
    "Browse available custom emoji packs.",
    {},
    async () => textResult(await callBridge("get_custom_emojis", {})),
  );

  // ── Folders ──────────────────────────────────────────────────────────────────

  server.tool(
    "get_chat_folders",
    "List all chat folders (filters) with their settings.",
    {},
    async () => textResult(await callBridge("get_chat_folders", {})),
  );

  server.tool(
    "create_chat_folder",
    `Create a new chat folder. Set flags to auto-include chat types.
Example: create_chat_folder(title="Work", groups=true, exclude_muted=true)`,
    {
      title: z.string().describe("Folder name"),
      emoticon: z.string().optional().describe("Folder icon emoji"),
      contacts: z.boolean().optional().describe("Include contacts"),
      non_contacts: z.boolean().optional().describe("Include non-contacts"),
      groups: z.boolean().optional().describe("Include groups"),
      broadcasts: z.boolean().optional().describe("Include channels"),
      bots: z.boolean().optional().describe("Include bots"),
      exclude_muted: z.boolean().optional().describe("Exclude muted chats"),
      exclude_read: z.boolean().optional().describe("Exclude read chats"),
      exclude_archived: z.boolean().optional().describe("Exclude archived (default true)"),
    },
    async (p) => textResult(await callBridge("create_chat_folder", p)),
  );

  server.tool(
    "delete_chat_folder",
    "Delete a chat folder.",
    { id: z.number().describe("Folder ID from get_chat_folders") },
    async (p) => textResult(await callBridge("delete_chat_folder", p)),
  );

  server.tool(
    "add_chat_to_folder",
    "Add a chat to a folder.",
    {
      folder_id: z.number().describe("Folder ID"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("add_chat_to_folder", p)),
  );

  // ── Saved messages ───────────────────────────────────────────────────────────

  server.tool(
    "list_saved_messages",
    "List messages in your Saved Messages.",
    { limit: z.number().optional().describe("Max messages (default 20)") },
    async (p) => textResult(await callBridge("list_saved_messages", p)),
  );

  server.tool(
    "search_saved_messages",
    "Search through your Saved Messages by keyword.",
    {
      query: z.string().describe("Search term"),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async (p) => textResult(await callBridge("search_saved_messages", p)),
  );

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

  // ── Scheduled messages ───────────────────────────────────────────────────────

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

  // ── Admin ────────────────────────────────────────────────────────────────────

  server.tool(
    "get_admin_log",
    "View recent admin actions in a group (who changed what, when).",
    {
      limit: z.number().optional().describe("Number of log entries (default 20, max 100)"),
    },
    async (p) => textResult(await callBridge("get_admin_log", p)),
  );

  server.tool(
    "get_admin_rights",
    "List all admins with their specific permissions.",
    { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
    async (p) => textResult(await callBridge("get_admin_rights", p)),
  );

  // ── Misc ─────────────────────────────────────────────────────────────────────

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
    "get_web_page_preview",
    "Get link preview data (title, description, photo) without sending a message.",
    {
      url: z.string().describe("URL to preview"),
    },
    async (p) => textResult(await callBridge("get_web_page_preview", p)),
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
    "delete_messages_by_date",
    "Delete messages in a date range.",
    {
      from_date: z.string().describe("Start date (ISO format)"),
      to_date: z.string().optional().describe("End date (ISO, defaults to now)"),
      limit: z.number().optional().describe("Max messages to delete (default 100)"),
      revoke: z.boolean().optional().describe("Delete for everyone (default true)"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("delete_messages_by_date", p)),
  );

  server.tool(
    "unpin_all_messages",
    "Unpin all pinned messages in a chat.",
    { chat_id: z.number().optional().describe("Chat ID (defaults to current chat)") },
    async (p) => textResult(await callBridge("unpin_all_messages", p)),
  );

  // ── Polls (media version) ────────────────────────────────────────────────────

  server.tool(
    "send_poll",
    "Send a poll to any chat using MTProto (userbot variant with more options).",
    {
      question: z.string().describe("Poll question"),
      options: z.array(z.string()).describe("Poll options"),
      is_anonymous: z.boolean().optional().describe("Anonymous poll"),
      allows_multiple_answers: z.boolean().optional().describe("Allow multiple answers"),
      correct_option_id: z.number().optional().describe("Quiz correct answer index"),
      explanation: z.string().optional().describe("Quiz explanation"),
      chat_id: z.number().optional().describe("Chat ID (defaults to current chat)"),
    },
    async (p) => textResult(await callBridge("send_poll", p)),
  );
}
