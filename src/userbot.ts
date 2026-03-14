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

const SESSION_FILE = resolve(process.cwd(), "workspace", ".user-session");

let client: TelegramClient | null = null;

export function isUserClientReady(): boolean {
  return client !== null && client.connected;
}

export async function initUserClient(params: {
  apiId: number;
  apiHash: string;
}): Promise<boolean> {
  const { apiId, apiHash } = params;

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
      console.log("[userbot] Not authorized — run the login script first.");
      client = null;
      return false;
    }

    // Save session after successful connect
    const newSession = client.session.save() as unknown as string;
    const dir = dirname(SESSION_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SESSION_FILE, newSession);

    console.log("[userbot] Connected and authorized.");
    return true;
  } catch (err) {
    console.error("[userbot] Connection failed:", err instanceof Error ? err.message : err);
    client = null;
    return false;
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
    const messages = await client.getMessages(params.chatId, {
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
    const opts: Record<string, unknown> = {
      limit: params.limit ?? 30,
    };
    if (params.offsetId) {
      opts.offsetId = params.offsetId;
    }
    if (params.before) {
      // Accept ISO string like "2026-03-13" or unix timestamp
      const ts = typeof params.before === "string"
        ? Math.floor(new Date(params.before).getTime() / 1000)
        : params.before;
      if (ts > 0) opts.offsetDate = ts;
    }
    const messages = await client.getMessages(params.chatId, opts);

    if (messages.length === 0) return "No messages found.";

    return messages
      .toReversed()
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
    const participants = await client.getParticipants(params.chatId, {
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

/** Get a specific message by ID. */
export async function getMessage(params: {
  chatId: number | string;
  messageId: number;
}): Promise<string> {
  if (!client) return "User client not connected.";

  try {
    const messages = await client.getMessages(params.chatId, {
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
