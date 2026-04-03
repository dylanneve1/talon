/**
 * GramJS user client for accessing Telegram features unavailable to bots:
 * - Full message history search and retrieval
 * - Group member enumeration
 * - Message search across chats
 *
 * Requires a one-time phone login to create a session file.
 * After that, runs headless alongside the bot.
 */

import { TelegramClient, Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { StringSession } from "telegram/sessions/index.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { log, logError, logWarn } from "../../util/log.js";
import { dirs, files } from "../../util/paths.js";
import { markdownToTelegramHtml } from "./formatting.js";
import { formatSmartTimestamp } from "../../util/time.js";

const SESSION_FILE = files.userSession;

let client: TelegramClient | null = null;
let reconnectTimer: ReturnType<typeof setInterval> | null = null;
let storedApiId = 0;
let storedApiHash = "";

// ── Primary mode flag ────────────────────────────────────────────────────────
// When true the user account IS the bot — scope guard is bypassed since the
// user account only ever sees its own chats anyway.
let _primary = false;

/** Enable or disable primary mode (user account as main frontend). */
export function setUserbotPrimary(primary: boolean): void {
  _primary = primary;
}

/** Whether this userbot is running as the primary (only) frontend. */
export function isUserbotPrimary(): boolean {
  return _primary;
}

// ── SECURITY: Chat scope guard ──────────────────────────────────────────────
// The userbot is ONLY allowed to access chats the bot is actively serving.
// It must NEVER access the user's other chats, DMs, or account data.
// In primary mode this guard is bypassed — the user account owns all its chats.
const allowedChatIds = new Set<number>();
const MAX_ALLOWED_CHATS = 5_000;

/** Allow the userbot to access a specific chat (set when bot receives a message). */
export function allowChat(chatId: number): void {
  if (allowedChatIds.size >= MAX_ALLOWED_CHATS) {
    // Evict oldest entries (first inserted) to prevent unbounded growth
    const iter = allowedChatIds.values();
    for (let i = 0; i < 500; i++) {
      const val = iter.next();
      if (val.done) break;
      allowedChatIds.delete(val.value);
    }
  }
  allowedChatIds.add(chatId);
}

/** Revoke userbot access for a chat (called when bot is removed from group). */
export function revokeChat(chatId: number): void {
  allowedChatIds.delete(chatId);
}

function assertAllowedChat(chatId: number | string): number {
  const numeric = typeof chatId === "string" ? parseInt(chatId, 10) : chatId;
  if (!_primary && !allowedChatIds.has(numeric)) {
    throw new Error(
      "Access denied: userbot can only access chats where the bot is active.",
    );
  }
  return numeric;
}

export function isUserClientReady(): boolean {
  return client !== null && !!client.connected;
}

export async function initUserClient(params: {
  apiId: number;
  apiHash: string;
}): Promise<boolean> {
  const { apiId, apiHash } = params;
  storedApiId = apiId;
  storedApiHash = apiHash;

  // Load saved session
  let sessionString = "";
  if (existsSync(SESSION_FILE)) {
    sessionString = readFileSync(SESSION_FILE, "utf-8").trim();
  }

  const session = new StringSession(sessionString);
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.connect();

    if (!(await client.isUserAuthorized())) {
      log("userbot", "Not authorized -- run the login script first.");
      client = null;
      return false;
    }

    // Save session after successful connect
    const newSession = client.session.save() as unknown as string;
    const dir = dirname(SESSION_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SESSION_FILE, newSession);

    log("userbot", "Connected and authorized.");

    // Start periodic connection health check
    startConnectionMonitor();

    return true;
  } catch (err) {
    logError("userbot", "Connection failed", err);
    client = null;
    return false;
  }
}

/** Gracefully disconnect the GramJS user client. */
export async function disconnectUserClient(): Promise<void> {
  stopConnectionMonitor();
  if (client) {
    try {
      await client.disconnect();
      log("userbot", "Disconnected.");
    } catch (err) {
      logError("userbot", "Disconnect error", err);
    }
    client = null;
  }
}

// ── Connection monitoring ────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let reconnecting = false;

function startConnectionMonitor(): void {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (!client) return;
    if (client.connected) return;
    if (reconnecting) return; // prevent overlapping reconnect attempts
    reconnecting = true;

    logWarn("userbot", "Connection lost, attempting reconnect...");
    try {
      await client.connect();
      if (await client.isUserAuthorized()) {
        log("userbot", "Reconnected successfully.");
      } else {
        logWarn("userbot", "Reconnected but not authorized.");
      }
    } catch (err) {
      logError("userbot", "Reconnect failed", err);
      // Try a full re-init on next check
      if (storedApiId && storedApiHash) {
        try {
          client = null;
          let sessionString = "";
          if (existsSync(SESSION_FILE)) {
            sessionString = readFileSync(SESSION_FILE, "utf-8").trim();
          }
          const session = new StringSession(sessionString);
          client = new TelegramClient(session, storedApiId, storedApiHash, {
            connectionRetries: 5,
          });
          await client.connect();
          if (await client.isUserAuthorized()) {
            log("userbot", "Full re-init reconnect succeeded.");
          }
        } catch (retryErr) {
          logError("userbot", "Full re-init reconnect failed", retryErr);
          client = null;
        }
      }
    } finally {
      reconnecting = false;
    }
  }, CHECK_INTERVAL_MS);
}

function stopConnectionMonitor(): void {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

/** Search messages in a chat by keyword. */
export async function searchMessages(params: {
  chatId: number | string;
  query: string;
  limit?: number;
}): Promise<string> {
  if (!client) return "User client not connected. Run login script first.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const messages = await client.getMessages(chatId, {
      search: params.query,
      limit: params.limit ?? 20,
    });

    if (messages.length === 0) return `No messages matching "${params.query}".`;

    return messages
      .map((m) => {
        const date = formatSmartTimestamp(m.date * 1000);
        const sender =
          m.sender && "firstName" in m.sender
            ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
            : "Unknown";
        return `[msg:${m.id} ${date}] ${sender}: ${m.text || "(media)"}`;
      })
      .join("\n");
  } catch (err) {
    return `Search failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get message history from a chat. Supports going back in time via offsetDate or offsetId. */
export async function getHistory(params: {
  chatId: number | string;
  limit?: number;
  offsetId?: number;
  /** ISO date string or unix timestamp to start fetching from (goes backward from this point). */
  before?: string | number;
}): Promise<string> {
  if (!client) return "User client not connected. Run login script first.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const opts: Record<string, unknown> = {
      limit: params.limit ?? 30,
    };
    if (params.offsetId) {
      opts.offsetId = params.offsetId;
    }
    if (params.before) {
      const ts =
        typeof params.before === "string"
          ? Math.floor(new Date(params.before).getTime() / 1000)
          : params.before;
      if (ts > 0) opts.offsetDate = ts;
    }
    const messages = await client.getMessages(chatId, opts);

    if (messages.length === 0) return "No messages found.";

    return [...messages]
      .reverse()
      .map((m) => {
        const date = formatSmartTimestamp(m.date * 1000);
        const sender =
          m.sender && "firstName" in m.sender
            ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
            : "Unknown";
        const replyTag = m.replyTo?.replyToMsgId
          ? ` (reply to msg:${m.replyTo.replyToMsgId})`
          : "";
        const mediaTag = m.media ? ` [${m.media.className}]` : "";
        return `[msg:${m.id} ${date}] ${sender}${replyTag}${mediaTag}: ${m.text || "(media)"}`;
      })
      .join("\n");
  } catch (err) {
    return `History failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get detailed participant info including admin status, join date, etc. */
export async function getParticipantDetails(params: {
  chatId: number | string;
  limit?: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const participants = await client.getParticipants(chatId, {
      limit: params.limit ?? 50,
    });

    if (participants.length === 0) return "No participants found.";

    return participants
      .map((p) => {
        const name =
          [p.firstName, p.lastName].filter(Boolean).join(" ") || "(no name)";
        const username = p.username ? `@${p.username}` : "";
        const bot = p.bot ? " [BOT]" : "";
        const verified = p.verified ? " [verified]" : "";
        const premium = p.premium ? " [premium]" : "";
        const status = (() => {
          const s = p.status;
          if (!s) return "unknown";
          const cn = s.className;
          if (cn === "UserStatusOnline") return "online";
          if (cn === "UserStatusOffline") {
            const off = s as { wasOnline?: number };
            if (off.wasOnline) {
              return `last seen ${formatSmartTimestamp(off.wasOnline * 1000)}`;
            }
            return "offline";
          }
          if (cn === "UserStatusRecently") return "recently";
          if (cn === "UserStatusLastWeek") return "last week";
          if (cn === "UserStatusLastMonth") return "last month";
          return cn;
        })();

        return `${name}${verified}${premium}${bot} ${username}\n  ID: ${p.id} | Status: ${status}`;
      })
      .join("\n\n");
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get info about a specific user by ID -- only works if they're in an allowed chat. */
export async function getUserInfo(params: {
  chatId: number | string;
  userId: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    // Fetch participants so GramJS caches the user entities for getEntity below
    await client.getParticipants(chatId, { limit: 1, search: "" });
    // getEntity only works for users the client has seen
    const entity = await client.getEntity(params.userId).catch(() => null);
    if (!entity || !("firstName" in entity)) {
      return `User ${params.userId} not found or not accessible.`;
    }

    const u = entity;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
    const username = u.username ? `@${u.username}` : "(no username)";
    const bot = u.bot ? "Yes" : "No";
    const verified = u.verified ? "Yes" : "No";
    const premium = u.premium ? "Yes" : "No";
    const phone = u.phone ? "(has phone)" : "(no phone visible)";
    const status = (() => {
      const s = u.status;
      if (!s) return "unknown";
      const cn = s.className;
      if (cn === "UserStatusOnline") return "Online";
      if (cn === "UserStatusOffline") {
        const off = s as { wasOnline?: number };
        if (off.wasOnline)
          return `Last seen ${formatSmartTimestamp(off.wasOnline * 1000)}`;
        return "Offline";
      }
      if (cn === "UserStatusRecently") return "Recently";
      if (cn === "UserStatusLastWeek") return "Last week";
      if (cn === "UserStatusLastMonth") return "Last month";
      return cn;
    })();

    return [
      `Name: ${name}`,
      `Username: ${username}`,
      `ID: ${u.id}`,
      `Status: ${status}`,
      `Bot: ${bot}`,
      `Verified: ${verified}`,
      `Premium: ${premium}`,
      `Phone: ${phone}`,
    ].join("\n");
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get a specific message by ID. */
export async function getMessage(params: {
  chatId: number | string;
  messageId: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const messages = await client.getMessages(chatId, {
      ids: [params.messageId],
    });
    const m = messages[0];
    if (!m) return `Message ${params.messageId} not found.`;

    const date = formatSmartTimestamp(m.date * 1000);
    const sender =
      m.sender && "firstName" in m.sender
        ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
        : "Unknown";
    const replyTag = m.replyTo?.replyToMsgId
      ? `\nReply to: msg:${m.replyTo.replyToMsgId}`
      : "";
    const mediaTag = m.media ? `\nMedia: ${m.media.className}` : "";
    return `[msg:${m.id} ${date}] ${sender}${replyTag}${mediaTag}\n${m.text || "(no text)"}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Download media from a message and save to workspace/uploads/. */
export async function downloadMessageMedia(params: {
  chatId: number | string;
  messageId: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const messages = await client.getMessages(chatId, {
      ids: [params.messageId],
    });
    const m = messages[0];
    if (!m) return `Message ${params.messageId} not found.`;
    if (!m.media) return `Message ${params.messageId} has no media.`;

    // Download the media using GramJS
    const buffer = (await client.downloadMedia(m.media, {})) as Buffer;
    if (!buffer || buffer.length === 0) return "Download returned empty data.";

    // Use the original filename if available, otherwise generate one
    const doc = (m.media as { document?: { attributes?: Array<{ fileName?: string }> } }).document;
    const originalName = doc?.attributes?.find((a) => a.fileName)?.fileName;
    const filename = originalName
      ? `${Date.now()}-${originalName.replace(/[^a-zA-Z0-9._-]/g, "_")}`
      : `${Date.now()}-msg${params.messageId}`;

    // Save to .talon/workspace/uploads/
    const uploadsDir = dirs.uploads;
    if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });

    const filePath = resolve(uploadsDir, filename);
    writeFileSync(filePath, buffer);

    log("userbot", `Downloaded media from msg:${params.messageId} → ${filename} (${buffer.length} bytes)`);
    return `Downloaded to: ${filePath} (${buffer.length} bytes). Use the Read tool on this path to view the content.`;
  } catch (err) {
    return `Download failed: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Sticker pack utilities ────────────────────────────────────────────────────

/** Save a sticker pack's file_ids to workspace for quick reuse. */
export async function saveStickerPack(params: {
  setName: string;
  bot: unknown;
}): Promise<string> {
  try {
    const bot = params.bot as { api: { getStickerSet: (name: string) => Promise<{ title: string; name: string; stickers: Array<{ emoji?: string; file_id: string }> }> } };
    const stickerSet = await bot.api.getStickerSet(params.setName);

    const stickers = stickerSet.stickers.map((s) => ({
      emoji: s.emoji ?? "",
      fileId: s.file_id,
    }));

    const packData = {
      name: stickerSet.name,
      title: stickerSet.title,
      count: stickers.length,
      stickers,
      savedAt: new Date().toISOString(),
    };

    const dir = dirs.stickers;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, `${stickerSet.name}.json`);
    writeFileSync(filePath, JSON.stringify(packData, null, 2));

    return `Saved "${stickerSet.title}" (${stickers.length} stickers) to .talon/workspace/stickers/${stickerSet.name}.json`;
  } catch (err) {
    return `Failed to save sticker pack: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Chat statistics & utility ────────────────────────────────────────────────

/** Get detailed chat/group statistics — message counts, top posters, activity. */
/** Get the pinned message(s) in a chat. */
export async function getPinnedMessages(params: {
  chatId: number | string;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const result = await client.invoke(
      new Api.messages.Search({
        peer: chatId,
        q: "",
        filter: new Api.InputMessagesFilterPinned(),
        minDate: 0,
        maxDate: 0,
        offsetId: 0,
        addOffset: 0,
        limit: 10,
        maxId: 0,
        minId: 0,
        hash: BigInt(0) as unknown as import("big-integer").BigInteger,
      }),
    );

    if (!("messages" in result) || result.messages.length === 0) {
      return "No pinned messages.";
    }

    const lines = result.messages.map((m) => {
      if (!("message" in m)) return `[msg:${m.id}] (no text)`;
      const date = formatSmartTimestamp(m.date * 1000);
      const text = m.message?.slice(0, 200) ?? "(media only)";
      return `[msg:${m.id} ${date}] ${text}`;
    });

    return `Pinned messages (${lines.length}):\n${lines.join("\n")}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** Get online/recently-active member count for a chat. */
export async function getOnlineCount(params: {
  chatId: number | string;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const participants = await client.getParticipants(chatId, { limit: 200 });

    let online = 0;
    let recently = 0;
    let total = participants.length;

    for (const p of participants) {
      if (p.bot) continue;
      const status = p.status?.className;
      if (status === "UserStatusOnline") online++;
      else if (status === "UserStatusRecently") recently++;
    }

    return `Members: ${total} total, ${online} online, ${recently} recently active`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}

// ── Self info (primary mode) ─────────────────────────────────────────────────

export type SelfInfo = {
  id: bigint;
  firstName?: string;
  lastName?: string;
  username?: string;
};

let _selfInfo: SelfInfo | null = null;

/** Get the raw GramJS client (for advanced use in userbot-frontend). */
export function getClient(): TelegramClient | null {
  return client;
}

/** Return cached self info (populated by fetchSelfInfo after connect). */
export function getSelfInfo(): SelfInfo | null {
  return _selfInfo;
}

/** Fetch and cache the logged-in user's own profile. */
export async function fetchSelfInfo(): Promise<SelfInfo | null> {
  if (!client) return null;
  try {
    const me = await client.getMe();
    _selfInfo = {
      id: me.id as unknown as bigint,
      firstName: me.firstName ?? undefined,
      lastName: (me as { lastName?: string }).lastName ?? undefined,
      username: me.username ?? undefined,
    };
    log("userbot", `Self: ${_selfInfo.firstName ?? ""} ${_selfInfo.username ? `@${_selfInfo.username}` : ""} id:${_selfInfo.id}`);
    return _selfInfo;
  } catch (err) {
    logError("userbot", "Failed to fetch self info", err);
    return null;
  }
}

// ── Send helpers (primary mode) ──────────────────────────────────────────────
// Used by userbot-frontend and userbot-actions when the user account is the
// primary frontend (no bot token required).

type Peer = number | bigint | string;

/** Send a text message. Converts Markdown → Telegram HTML internally. Returns sent message ID. */
export async function sendUserbotMessage(
  peer: Peer,
  text: string,
  replyTo?: number,
): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const html = markdownToTelegramHtml(text);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await client.sendMessage(peer as any, { message: html, parseMode: "html", replyTo, linkPreview: false });
    return sent.id;
  } catch {
    // Fallback: send as plain text if HTML parsing fails
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await client.sendMessage(peer as any, { message: text, replyTo, linkPreview: false });
    return sent.id;
  }
}

/** Send a typing indicator. Silently ignores errors (non-critical). */
export async function sendUserbotTyping(peer: Peer): Promise<void> {
  if (!client) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.invoke(new Api.messages.SetTyping({ peer: peer as any, action: new Api.SendMessageTypingAction() }));
  } catch { /* non-critical */ }
}

/** Edit an existing message. */
export async function editUserbotMessage(
  peer: Peer,
  msgId: number,
  text: string,
): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  const html = markdownToTelegramHtml(text);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.editMessage(peer as any, { message: msgId, text: html, parseMode: "html" });
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.editMessage(peer as any, { message: msgId, text });
  }
}

/** Delete a message (revokes for both sides). */
export async function deleteUserbotMessage(peer: Peer, msgId: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.deleteMessages(peer as any, [msgId], { revoke: true });
}

/** React to a message with an emoji. */
export async function reactUserbotMessage(
  peer: Peer,
  msgId: number,
  emoji: string,
): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.messages.SendReaction({ peer: peer as any, msgId, reaction: [new Api.ReactionEmoji({ emoticon: emoji })] }),
  );
}

/** Remove all reactions from a message (silently ignores errors). */
export async function clearUserbotReactions(peer: Peer, msgId: number): Promise<void> {
  if (!client) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.invoke(new Api.messages.SendReaction({ peer: peer as any, msgId, reaction: [] }));
  } catch { /* non-critical */ }
}

/** Pin a message in a chat. */
export async function pinUserbotMessage(peer: Peer, msgId: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: peer as any, id: msgId, silent: true }));
}

/** Unpin a message (or all messages if msgId omitted). */
export async function unpinUserbotMessage(peer: Peer, msgId?: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  if (msgId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: peer as any, id: msgId, unpin: true, silent: true }));
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.invoke(new Api.messages.UnpinAllMessages({ peer: peer as any }));
  }
}

/** Forward a message within the same chat. Returns new message ID. */
export async function forwardUserbotMessage(peer: Peer, msgId: number): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = await client.forwardMessages(peer as any, { messages: [msgId], fromPeer: peer as any });
  const sent = results[0];
  return (sent as { id?: number })?.id ?? 0;
}

export type SendFileParams = {
  filePath: string;
  caption?: string;
  replyTo?: number;
  /** "voice" | "video_note" | "photo" | "video" | "audio" | "document" | "animation" */
  type?: string;
  title?: string;
  performer?: string;
};

/** Send a file (photo/video/audio/voice/document) via userbot. Returns sent message ID. */
export async function sendUserbotFile(peer: Peer, params: SendFileParams): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const { filePath, caption, replyTo, type, title, performer } = params;
  const sent = await client.sendFile(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    peer as any,
    {
      file: filePath,
      caption: caption ?? "",
      parseMode: caption ? "html" : undefined,
      replyTo,
      voiceNote: type === "voice",
      videoNote: type === "video_note",
      attributes: (type === "audio" && (title || performer))
        ? [new Api.DocumentAttributeAudio({ duration: 0, title, performer })]
        : undefined,
    },
  );
  return sent.id;
}

/** Get basic entity info for a chat. */
export async function getUserbotEntity(peer: Peer): Promise<Record<string, unknown>> {
  if (!client) throw new Error("User client not connected.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entity = await client.getEntity(peer as any) as any;
  const id = Number(entity.id ?? 0);
  const type = entity.className === "User" ? "private"
    : entity.className === "Chat" ? "group"
    : "channel";
  const title = entity.title ?? entity.firstName ?? undefined;
  return { id, type, title };
}

/** Get admin list for a chat as a formatted string. */
export async function getUserbotAdmins(peer: Peer): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  try {
    const participants = await client.getParticipants(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer as any,
      { filter: new Api.ChannelParticipantsAdmins() },
    );
    if (participants.length === 0) return "No admins found.";
    return participants.map((p) => {
      const name = [p.firstName, (p as { lastName?: string }).lastName].filter(Boolean).join(" ") || "(no name)";
      const username = p.username ? ` @${p.username}` : "";
      return `${name}${username} id:${Number(p.id)}`;
    }).join("\n");
  } catch {
    return "Could not retrieve admins (not a channel/supergroup).";
  }
}

/** Get total participant count for a chat. */
export async function getUserbotMemberCount(peer: Peer): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const participants = await client.getParticipants(peer as any, { limit: 1 });
  return (participants as unknown as { total?: number }).total ?? participants.length;
}

// ── Profile management ────────────────────────────────────────────────────────

/** Edit own profile name and/or bio. */
export async function editUserbotProfile(params: {
  firstName?: string;
  lastName?: string;
  bio?: string;
}): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.account.UpdateProfile({
      firstName: params.firstName,
      lastName: params.lastName,
      about: params.bio,
    }),
  );
}

/** Update own Telegram username. Empty string removes it. */
export async function updateUserbotUsername(username: string): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.account.UpdateUsername({ username }),
  );
}

/** Upload a photo as the profile picture. Returns the new photo ID as a string. */
export async function setUserbotProfilePhoto(filePath: string): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const fileData = readFileSync(filePath);
  const uploadedFile = await client.uploadFile({
    file: new CustomFile(basename(filePath), fileData.length, filePath),
    workers: 1,
  });
  const result = await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.photos.UploadProfilePhoto({ file: uploadedFile as any }),
  );
  const photo = (result as { photo?: { id?: unknown } }).photo;
  return String(photo?.id ?? "unknown");
}

/** Delete all profile photos. Returns the number of photos deleted. */
export async function deleteUserbotProfilePhotos(): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.photos.GetUserPhotos({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: "me" as any,
      offset: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      maxId: BigInt(0) as any,
      limit: 100,
    }),
  );
  const photos = (result as { photos?: unknown[] }).photos ?? [];
  if (photos.length === 0) return 0;
  await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.photos.DeletePhotos({ id: photos as any }),
  );
  return photos.length;
}

// ── Chat management ──────────────────────────────────────────────────────────

/** Set the title of a chat/channel/group. */
export async function setUserbotChatTitle(peer: Peer, title: string): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  try {
    await client.invoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Api.channels.EditTitle({ channel: peer as any, title }),
    );
  } catch {
    // Fallback for basic groups
    await client.invoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Api.messages.EditChatTitle({ chatId: peer as any, title }),
    );
  }
}

/** Set the description/about of a chat. */
export async function setUserbotChatDescription(peer: Peer, about: string): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.messages.EditChatAbout({ peer: peer as any, about }),
  );
}

/** Upload a photo and set it as the chat photo. */
export async function setUserbotChatPhoto(peer: Peer, filePath: string): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  const fileData = readFileSync(filePath);
  const uploadedFile = await client.uploadFile({
    file: new CustomFile(basename(filePath), fileData.length, filePath),
    workers: 1,
  });
  await client.invoke(
    new Api.channels.EditPhoto({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      photo: new Api.InputChatUploadedPhoto({ file: uploadedFile as any }),
    }),
  );
}

/** Join a chat by username (@name) or invite link (https://t.me/+xxx). */
export async function joinUserbotChat(target: string): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  if (target.includes("t.me/+") || target.includes("t.me/joinchat/")) {
    // Extract the hash from the invite link
    const hash = target.split("/").pop() ?? target;
    const cleanHash = hash.startsWith("+") ? hash.slice(1) : hash;
    await client.invoke(
      new Api.messages.ImportChatInvite({ hash: cleanHash }),
    );
  } else {
    const username = target.startsWith("@") ? target.slice(1) : target;
    await client.invoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new Api.channels.JoinChannel({ channel: username as any }),
    );
  }
}

/** Leave a chat. */
export async function leaveUserbotChat(peer: Peer): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.channels.LeaveChannel({ channel: peer as any }),
  );
}

/** Create a basic group with given users. Returns new chat ID. */
export async function createUserbotGroup(title: string, userIds: number[]): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.messages.CreateChat({ users: userIds as any, title }),
  );
  const updates = result as { chats?: Array<{ id?: unknown }> };
  return Number(updates.chats?.[0]?.id ?? 0);
}

/** Create a supergroup or channel. Returns new chat ID. */
export async function createUserbotSupergroup(params: {
  title: string;
  about?: string;
  isBroadcast?: boolean;
}): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.channels.CreateChannel({
      title: params.title,
      about: params.about ?? "",
      megagroup: !params.isBroadcast,
      broadcast: !!params.isBroadcast,
    }),
  );
  const updates = result as { chats?: Array<{ id?: unknown }> };
  return Number(updates.chats?.[0]?.id ?? 0);
}

/** Invite user(s) to a chat. */
export async function inviteUserbotUsers(peer: Peer, userIds: number[]): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.channels.InviteToChannel({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      users: userIds as any,
    }),
  );
}

// ── Member management ────────────────────────────────────────────────────────

/** Ban/kick a member. untilDate=0 means permanent. */
export async function kickUserbotMember(peer: Peer, userId: number, untilDate?: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.channels.EditBanned({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      participant: userId as any,
      bannedRights: new Api.ChatBannedRights({
        untilDate: untilDate ?? 0,
        viewMessages: true,
        sendMessages: true,
        sendMedia: true,
        sendStickers: true,
        sendGifs: true,
        sendGames: true,
        sendInline: true,
        embedLinks: true,
      }),
    }),
  );
}

/** Unban a member (restore default rights). */
export async function unbanUserbotMember(peer: Peer, userId: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.channels.EditBanned({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      participant: userId as any,
      bannedRights: new Api.ChatBannedRights({
        untilDate: 0,
        viewMessages: false,
        sendMessages: false,
        sendMedia: false,
        sendStickers: false,
        sendGifs: false,
        sendGames: false,
        sendInline: false,
        embedLinks: false,
      }),
    }),
  );
}

/** Restrict a member — pass specific rights to REMOVE. */
export async function restrictUserbotMember(peer: Peer, userId: number, params: {
  noMessages?: boolean;
  noMedia?: boolean;
  noStickers?: boolean;
  noGifs?: boolean;
  noGames?: boolean;
  noInline?: boolean;
  noPoll?: boolean;
  noWebPreview?: boolean;
  untilDate?: number;
}): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.channels.EditBanned({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      participant: userId as any,
      bannedRights: new Api.ChatBannedRights({
        untilDate: params.untilDate ?? 0,
        viewMessages: false,
        sendMessages: !!params.noMessages,
        sendMedia: !!params.noMedia,
        sendStickers: !!params.noStickers,
        sendGifs: !!params.noGifs,
        sendGames: !!params.noGames,
        sendInline: !!params.noInline,
        sendPolls: !!params.noPoll,
        embedLinks: !!params.noWebPreview,
      }),
    }),
  );
}

/** Promote a user to admin with optional rights and title. */
export async function promoteUserbotAdmin(peer: Peer, userId: number, params: {
  changeInfo?: boolean;
  postMessages?: boolean;
  editMessages?: boolean;
  deleteMessages?: boolean;
  banUsers?: boolean;
  inviteUsers?: boolean;
  pinMessages?: boolean;
  manageCall?: boolean;
  anonymous?: boolean;
  addAdmins?: boolean;
  title?: string;
}): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.channels.EditAdmin({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      adminRights: new Api.ChatAdminRights({
        changeInfo: !!params.changeInfo,
        postMessages: !!params.postMessages,
        editMessages: !!params.editMessages,
        deleteMessages: !!params.deleteMessages,
        banUsers: !!params.banUsers,
        inviteUsers: !!params.inviteUsers,
        pinMessages: !!params.pinMessages,
        manageCall: !!params.manageCall,
        anonymous: !!params.anonymous,
        addAdmins: !!params.addAdmins,
      }),
      rank: params.title ?? "",
    }),
  );
}

/** Demote an admin back to regular member. */
export async function demoteUserbotAdmin(peer: Peer, userId: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.channels.EditAdmin({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      adminRights: new Api.ChatAdminRights({
        changeInfo: false,
        postMessages: false,
        editMessages: false,
        deleteMessages: false,
        banUsers: false,
        inviteUsers: false,
        pinMessages: false,
        manageCall: false,
        anonymous: false,
        addAdmins: false,
      }),
      rank: "",
    }),
  );
}

/** Set a visual member tag (custom title) without granting any admin permissions.
 * This is the "member tags" feature — gives a visible tag next to name with zero actual rights. */
export async function setUserbotMemberTag(peer: Peer, userId: number, tag: string): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.channels.EditAdmin({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      adminRights: new Api.ChatAdminRights({
        changeInfo: false,
        postMessages: false,
        editMessages: false,
        deleteMessages: false,
        banUsers: false,
        inviteUsers: false,
        pinMessages: false,
        manageCall: false,
        anonymous: false,
        addAdmins: false,
        other: false,
      }),
      rank: tag,
    }),
  );
}

/** Toggle slow mode. seconds=0 to disable. */
export async function toggleUserbotSlowMode(peer: Peer, seconds: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.channels.ToggleSlowMode({ channel: peer as any, seconds }),
  );
}

// ── Messaging ────────────────────────────────────────────────────────────────

/** Send a location. Returns sent message ID. */
export async function sendUserbotLocation(peer: Peer, lat: number, long: number, replyTo?: number): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.messages.SendMedia({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any,
      media: new Api.InputMediaGeoPoint({
        geoPoint: new Api.InputGeoPoint({ lat, long }),
      }),
      message: "",
      randomId: BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000)) as unknown as import("big-integer").BigInteger,
      replyTo: replyTo ? new Api.InputReplyToMessage({ replyToMsgId: replyTo }) : undefined,
    }),
  );
  const updates = result as { updates?: Array<{ id?: number }>; id?: number };
  const msg = updates.updates?.find((u) => "id" in u && typeof u.id === "number");
  return (msg as { id?: number })?.id ?? 0;
}

/** Send a contact. Returns sent message ID. */
export async function sendUserbotContact(peer: Peer, params: {
  phone: string;
  firstName: string;
  lastName?: string;
}, replyTo?: number): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.messages.SendMedia({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any,
      media: new Api.InputMediaContact({
        phoneNumber: params.phone,
        firstName: params.firstName,
        lastName: params.lastName ?? "",
        vcard: "",
      }),
      message: "",
      randomId: BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000)) as unknown as import("big-integer").BigInteger,
      replyTo: replyTo ? new Api.InputReplyToMessage({ replyToMsgId: replyTo }) : undefined,
    }),
  );
  const updates = result as { updates?: Array<{ id?: number }> };
  const msg = updates.updates?.find((u) => "id" in u && typeof u.id === "number");
  return (msg as { id?: number })?.id ?? 0;
}

/** Send a poll. Returns sent message ID. */
export async function sendUserbotPoll(peer: Peer, params: {
  question: string;
  options: string[];
  isAnonymous?: boolean;
  allowMultiple?: boolean;
  quizAnswer?: number;
}, replyTo?: number): Promise<number> {
  if (!client) throw new Error("User client not connected.");
  const isQuiz = typeof params.quizAnswer === "number";
  const answers = params.options.map((opt, i) =>
    new Api.PollAnswer({ text: new Api.TextWithEntities({ text: opt, entities: [] }), option: Buffer.from([i]) }),
  );
  const result = await client.invoke(
    new Api.messages.SendMedia({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any,
      media: new Api.InputMediaPoll({
        poll: new Api.Poll({
          id: BigInt(Date.now()) as unknown as import("big-integer").BigInteger,
          question: new Api.TextWithEntities({ text: params.question, entities: [] }),
          answers,
          closed: false,
          publicVoters: !(params.isAnonymous ?? true),
          multipleChoice: !!(params.allowMultiple),
          quiz: isQuiz,
        }),
        correctAnswers: isQuiz && typeof params.quizAnswer === "number"
          ? [Buffer.from([params.quizAnswer])]
          : undefined,
      }),
      message: "",
      randomId: BigInt(Date.now() * 1000 + Math.floor(Math.random() * 1000)) as unknown as import("big-integer").BigInteger,
      replyTo: replyTo ? new Api.InputReplyToMessage({ replyToMsgId: replyTo }) : undefined,
    }),
  );
  const updates = result as { updates?: Array<{ id?: number }> };
  const msg = updates.updates?.find((u) => "id" in u && typeof u.id === "number");
  return (msg as { id?: number })?.id ?? 0;
}

/** Send multiple files as an album. Returns array of message IDs. */
export async function sendUserbotAlbum(peer: Peer, filePaths: string[], caption?: string, replyTo?: number): Promise<number[]> {
  if (!client) throw new Error("User client not connected.");
  const results = await client.sendFile(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    peer as any,
    {
      file: filePaths,
      caption: caption ?? "",
      parseMode: caption ? "html" : undefined,
      replyTo,
    },
  );
  const msgs = Array.isArray(results) ? results : [results];
  return msgs.map((m) => (m as { id?: number }).id ?? 0);
}

// ── Contacts & account ───────────────────────────────────────────────────────

/** Get all contacts as a formatted string. */
export async function getUserbotContacts(): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.contacts.GetContacts({ hash: BigInt(0) as unknown as import("big-integer").BigInteger }),
  );
  const contacts = (result as { users?: Array<{ firstName?: string; lastName?: string; username?: string; id?: unknown; phone?: string }> }).users ?? [];
  if (contacts.length === 0) return "No contacts.";
  return contacts.map((c) => {
    const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || "(no name)";
    const username = c.username ? ` @${c.username}` : "";
    const phone = c.phone ? ` +${c.phone}` : "";
    return `${name}${username}${phone} id:${Number(c.id ?? 0)}`;
  }).join("\n");
}

/** Add a contact by phone number. */
export async function addUserbotContact(params: { phone: string; firstName: string; lastName?: string }): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.contacts.ImportContacts({
      contacts: [
        new Api.InputPhoneContact({
          clientId: BigInt(Date.now()) as unknown as import("big-integer").BigInteger,
          phone: params.phone,
          firstName: params.firstName,
          lastName: params.lastName ?? "",
        }),
      ],
    }),
  );
}

/** Delete a contact by user ID. */
export async function deleteUserbotContact(userId: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.contacts.DeleteContacts({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      id: [userId as any],
    }),
  );
}

/** Block a user. */
export async function blockUserbotUser(userId: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.contacts.Block({ id: userId as any }),
  );
}

/** Unblock a user. */
export async function unblockUserbotUser(userId: number): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.contacts.Unblock({ id: userId as any }),
  );
}

/** Get list of blocked users. */
export async function getUsrebotBlockedUsers(limit?: number): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.contacts.GetBlocked({ offset: 0, limit: limit ?? 100 }),
  );
  const blocked = (result as { users?: Array<{ firstName?: string; lastName?: string; username?: string; id?: unknown }> }).users ?? [];
  if (blocked.length === 0) return "No blocked users.";
  return blocked.map((u) => {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)";
    const username = u.username ? ` @${u.username}` : "";
    return `${name}${username} id:${Number(u.id ?? 0)}`;
  }).join("\n");
}

// ── Utility ──────────────────────────────────────────────────────────────────

/** Mark messages as read up to maxId. Silently ignores errors (non-critical). */
export async function markUserbotAsRead(peer: Peer, maxId = 0): Promise<void> {
  if (!client) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.invoke(new Api.messages.ReadHistory({ peer: peer as any, maxId }));
  } catch { /* non-critical */ }
}

/** Global search across all chats. */
export async function searchUserbotGlobal(query: string, limit?: number): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.messages.SearchGlobal({
      q: query,
      filter: new Api.InputMessagesFilterEmpty(),
      minDate: 0,
      maxDate: 0,
      offsetRate: 0,
      offsetPeer: new Api.InputPeerEmpty(),
      offsetId: 0,
      limit: limit ?? 20,
    }),
  );
  const messages = (result as { messages?: Array<{ id?: number; message?: string; date?: number }> }).messages ?? [];
  if (messages.length === 0) return `No results for "${query}".`;
  return messages.map((m) => {
    const date = m.date ? formatSmartTimestamp(m.date * 1000) : "";
    return `[msg:${m.id} ${date}] ${m.message?.slice(0, 200) ?? "(media)"}`;
  }).join("\n");
}

/** Translate text using Telegram's built-in translation. */
export async function translateUserbotText(peer: Peer, msgIds: number[], toLang: string): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.messages.TranslateText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any,
      id: msgIds,
      toLang,
    }),
  );
  const results = (result as { result?: Array<{ text?: { text?: string } }> }).result ?? [];
  return results.map((r) => r.text?.text ?? "").join("\n");
}

/** Transcribe a voice/audio message. Returns text, or "pending" if not ready yet. */
export async function transcribeUserbotAudio(peer: Peer, msgId: number): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.messages.TranscribeAudio({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any,
      msgId,
    }),
  );
  const r = result as { text?: string; pending?: boolean };
  if (r.pending) return "pending";
  return r.text ?? "";
}

/** Get all chats/dialogs as formatted list. */
export async function getUserbotDialogs(limit?: number): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const dialogs = await client.getDialogs({ limit: limit ?? 50 });
  if (dialogs.length === 0) return "No dialogs found.";
  return dialogs.map((d) => {
    const name = (d as { title?: string; name?: string }).title ?? (d as { name?: string }).name ?? "(unknown)";
    const id = Number((d as { id?: unknown }).id ?? 0);
    const unread = (d as { unreadCount?: number }).unreadCount ?? 0;
    return `${name} id:${id}${unread > 0 ? ` [${unread} unread]` : ""}`;
  }).join("\n");
}

/** Get common chats with a user. */
export async function getUsrebotCommonChats(userId: number): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.messages.GetCommonChats({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
      limit: 100,
    }),
  );
  const chats = (result as { chats?: Array<{ id?: unknown; title?: string }> }).chats ?? [];
  if (chats.length === 0) return "No common chats.";
  return chats.map((c) => `${c.title ?? "(no title)"} id:${Number(c.id ?? 0)}`).join("\n");
}

// ── Stories ──────────────────────────────────────────────────────────────────

/** Get stories for a peer. */
export async function getUserbotStories(peer: Peer): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    new Api.stories.GetPeerStories({ peer: peer as any }),
  );
  const stories = (result as { stories?: { stories?: Array<{ id?: number; date?: number }> } }).stories?.stories ?? [];
  if (stories.length === 0) return "No stories.";
  return stories.map((s) => {
    const date = s.date ? formatSmartTimestamp(s.date * 1000) : "";
    return `[story:${s.id} ${date}]`;
  }).join("\n");
}

/** Delete stories by ID. */
export async function deleteUserbotStories(storyIds: number[]): Promise<void> {
  if (!client) throw new Error("User client not connected.");
  await client.invoke(
    new Api.stories.DeleteStories({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: "me" as any,
      id: storyIds,
    }),
  );
}

// ── Admin log ────────────────────────────────────────────────────────────────

/** Get admin log entries for a channel/group. */
export async function getUserbotAdminLog(peer: Peer, limit?: number): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.channels.GetAdminLog({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      q: "",
      maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
      minId: BigInt(0) as unknown as import("big-integer").BigInteger,
      limit: limit ?? 50,
    }),
  );
  const events = (result as { events?: Array<{ id?: unknown; date?: number; action?: { className?: string } }> }).events ?? [];
  if (events.length === 0) return "No admin log entries.";
  return events.map((e) => {
    const date = e.date ? formatSmartTimestamp(e.date * 1000) : "";
    return `[log:${String(e.id)} ${date}] ${e.action?.className ?? "unknown"}`;
  }).join("\n");
}

// ── Forum topics ─────────────────────────────────────────────────────────────

/** Get forum topics in a group. */
export async function getUserbotForumTopics(peer: Peer, limit?: number): Promise<string> {
  if (!client) throw new Error("User client not connected.");
  const result = await client.invoke(
    new Api.channels.GetForumTopics({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any,
      q: "",
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit: limit ?? 50,
    }),
  );
  const topics = (result as { topics?: Array<{ id?: number; title?: string; date?: number }> }).topics ?? [];
  if (topics.length === 0) return "No forum topics.";
  return topics.map((t) => {
    const date = t.date ? formatSmartTimestamp(t.date * 1000) : "";
    return `[topic:${t.id} ${date}] ${t.title ?? "(no title)"}`;
  }).join("\n");
}
