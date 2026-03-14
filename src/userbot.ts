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
import { StringSession } from "telegram/sessions/index.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { log, logError, logWarn } from "./log.js";

const SESSION_FILE = resolve(process.cwd(), "workspace", ".user-session");

let client: TelegramClient | null = null;
let reconnectTimer: ReturnType<typeof setInterval> | null = null;
let storedApiId = 0;
let storedApiHash = "";

// ── SECURITY: Chat scope guard ──────────────────────────────────────────────
// The userbot is ONLY allowed to access chats the bot is actively serving.
// It must NEVER access the user's other chats, DMs, or account data.
const allowedChatIds = new Set<number>();

/** Allow the userbot to access a specific chat (set when bot receives a message). */
export function allowChat(chatId: number): void {
  allowedChatIds.add(chatId);
}

function assertAllowedChat(chatId: number | string): number {
  const numeric = typeof chatId === "string" ? parseInt(chatId, 10) : chatId;
  if (!allowedChatIds.has(numeric)) {
    throw new Error("Access denied: userbot can only access chats where the bot is active.");
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

    if (!await client.isUserAuthorized()) {
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

function startConnectionMonitor(): void {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(async () => {
    if (!client) return;
    if (client.connected) return;

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
        const date = new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ");
        const sender = m.sender && "firstName" in m.sender
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
      const ts = typeof params.before === "string"
        ? Math.floor(new Date(params.before).getTime() / 1000)
        : params.before;
      if (ts > 0) opts.offsetDate = ts;
    }
    const messages = await client.getMessages(chatId, opts);

    if (messages.length === 0) return "No messages found.";

    return [...messages]
      .reverse()
      .map((m) => {
        const date = new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ");
        const sender = m.sender && "firstName" in m.sender
          ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
          : "Unknown";
        const replyTag = m.replyTo?.replyToMsgId ? ` (reply to msg:${m.replyTo.replyToMsgId})` : "";
        const mediaTag = m.media ? ` [${m.media.className}]` : "";
        return `[msg:${m.id} ${date}] ${sender}${replyTag}${mediaTag}: ${m.text || "(media)"}`;
      })
      .join("\n");
  } catch (err) {
    return `History failed: ${err instanceof Error ? err.message : err}`;
  }
}

/** List participants in a group/supergroup. */
export async function getParticipants(params: {
  chatId: number | string;
  limit?: number;
  query?: string;
}): Promise<string> {
  if (!client) return "User client not connected. Run login script first.";

  try {
    const chatId = assertAllowedChat(params.chatId);
    const participants = await client.getParticipants(chatId, {
      limit: params.limit ?? 50,
      search: params.query,
    });

    if (participants.length === 0) return "No participants found.";

    return participants
      .map((p) => {
        const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
        const username = p.username ? ` @${p.username}` : "";
        const bot = p.bot ? " [bot]" : "";
        return `${name}${username}${bot} (id: ${p.id})`;
      })
      .join("\n");
  } catch (err) {
    return `Participants failed: ${err instanceof Error ? err.message : err}`;
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
        const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "(no name)";
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
              const date = new Date(off.wasOnline * 1000);
              return `last seen ${date.toISOString().slice(0, 16).replace("T", " ")}`;
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
    // Fetch the user as a participant of the allowed chat
    const participants = await client.getParticipants(chatId, { limit: 1, search: "" });
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
        if (off.wasOnline) return `Last seen ${new Date(off.wasOnline * 1000).toISOString().slice(0, 16).replace("T", " ")}`;
        return "Offline";
      }
      if (cn === "UserStatusRecently") return "Recently";
      if (cn === "UserStatusLastWeek") return "Last week";
      if (cn === "UserStatusLastMonth") return "Last month";
      return cn;
    })();

    // Suppress actual phone from output
    void participants;
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

    const date = new Date(m.date * 1000).toISOString().slice(0, 16).replace("T", " ");
    const sender = m.sender && "firstName" in m.sender
      ? [m.sender.firstName, m.sender.lastName].filter(Boolean).join(" ")
      : "Unknown";
    const replyTag = m.replyTo?.replyToMsgId ? `\nReply to: msg:${m.replyTo.replyToMsgId}` : "";
    const mediaTag = m.media ? `\nMedia: ${m.media.className}` : "";
    return `[msg:${m.id} ${date}] ${sender}${replyTag}${mediaTag}\n${m.text || "(no text)"}`;
  } catch (err) {
    return `Failed: ${err instanceof Error ? err.message : err}`;
  }
}
