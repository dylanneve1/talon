/**
 * Group message history buffer. Stores recent messages from all users
 * so Claude has full conversation context even for messages that didn't
 * trigger the bot.
 *
 * Persisted to disk — survives restarts so pulse, search, and group
 * threading context don't lose state.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { formatSmartTimestamp, formatRelativeAge } from "../util/time.js";
import { registerCleanup } from "../util/cleanup-registry.js";

export type HistoryMessage = {
  msgId: number;
  senderId: number;
  senderName: string;
  text: string;
  replyToMsgId?: number;
  timestamp: number;
  mediaType?:
    | "photo"
    | "document"
    | "voice"
    | "sticker"
    | "video"
    | "animation";
  stickerFileId?: string;
  /** Saved file path for downloaded media. */
  filePath?: string;
};

const MAX_HISTORY_PER_CHAT = 500;
const MAX_CHAT_COUNT = 1000;
const STORE_FILE = files.history;

const chatHistories = new Map<string, HistoryMessage[]>();
let dirty = false;

// ── Persistence ─────────────────────────────────────────────────────────────

export function loadHistory(): void {
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8")) as Record<
        string,
        HistoryMessage[]
      >;
      for (const [chatId, messages] of Object.entries(raw)) {
        // Only load recent messages (cap per chat)
        const trimmed = messages.slice(-MAX_HISTORY_PER_CHAT);
        chatHistories.set(chatId, trimmed);
      }
      log("sessions", `Loaded history for ${chatHistories.size} chat(s)`);
    }
  } catch {
    // Primary file corrupt — try backup
    const bakFile = STORE_FILE + ".bak";
    try {
      if (existsSync(bakFile)) {
        const raw = JSON.parse(readFileSync(bakFile, "utf-8")) as Record<string, HistoryMessage[]>;
        for (const [chatId, messages] of Object.entries(raw)) {
          chatHistories.set(chatId, messages.slice(-MAX_HISTORY_PER_CHAT));
        }
        logError("sessions", "Loaded history from backup (primary was corrupt)");
        return;
      }
    } catch { /* backup also corrupt */ }
    logError("sessions", "History data corrupt and no valid backup — starting fresh");
  }
}

function saveHistory(): void {
  if (!dirty) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, HistoryMessage[]> = {};
    for (const [chatId, messages] of chatHistories) {
      obj[chatId] = messages;
    }
    const data = JSON.stringify(obj) + "\n";
    // Write backup of current file before overwriting
    if (existsSync(STORE_FILE)) {
      try { writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE)); } catch { /* best effort */ }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("history", "Failed to persist history", err);
    recordError(`History save failed: ${err instanceof Error ? err.message : err}`);
  }
}

// Auto-save every 30 seconds (less frequent than sessions since history is larger)
const autoSaveTimer = setInterval(saveHistory, 30_000);
registerCleanup(saveHistory);

export function flushHistory(): void {
  clearInterval(autoSaveTimer);
  dirty = true;
  saveHistory();
}

// ── Core operations ─────────────────────────────────────────────────────────

export function pushMessage(chatId: string, msg: HistoryMessage): void {
  let history = chatHistories.get(chatId);
  if (!history) {
    if (chatHistories.size >= MAX_CHAT_COUNT) {
      const evictCount = Math.floor(MAX_CHAT_COUNT * 0.1);
      const iter = chatHistories.keys();
      for (let i = 0; i < evictCount; i++) {
        const oldest = iter.next();
        if (oldest.done) break;
        chatHistories.delete(oldest.value);
      }
      // Mark dirty so evicted chats are removed from disk on next save
      dirty = true;
    }
    history = [];
    chatHistories.set(chatId, history);
  }
  history.push(msg);
  if (history.length > MAX_HISTORY_PER_CHAT) {
    history.splice(0, history.length - MAX_HISTORY_PER_CHAT);
  }
  dirty = true;
}

export function getRecentHistory(chatId: string, limit = 50): HistoryMessage[] {
  const history = chatHistories.get(chatId);
  if (!history) return [];
  return history.slice(-limit);
}

/** Update a message's file path after media download. */
export function setMessageFilePath(chatId: string, msgId: number, filePath: string): void {
  const history = chatHistories.get(chatId);
  if (!history) return;
  const msg = history.find((m) => m.msgId === msgId);
  if (msg) { msg.filePath = filePath; dirty = true; }
}

export function clearHistory(chatId: string): void {
  chatHistories.delete(chatId);
  dirty = true;
}

// ── Formatted queries ───────────────────────────────────────────────────────

function formatMessage(m: HistoryMessage): string {
  const replyTag = m.replyToMsgId ? ` (replying to msg:${m.replyToMsgId})` : "";
  const mediaTag = m.mediaType ? ` [${m.mediaType}]` : "";
  const stickerTag = m.stickerFileId
    ? ` (sticker_file_id: ${m.stickerFileId})`
    : "";
  const fileTag = m.filePath ? ` (file: ${m.filePath})` : "";
  const time = formatSmartTimestamp(m.timestamp);
  return `[msg:${m.msgId} ${time}] ${m.senderName}${replyTag}${mediaTag}${stickerTag}${fileTag}: ${m.text}`;
}

export function getRecentFormatted(chatId: string, limit = 20): string {
  const messages = getRecentHistory(chatId, limit);
  if (messages.length === 0) return "No messages in history.";
  return messages.map(formatMessage).join("\n");
}

export function searchHistory(
  chatId: string,
  query: string,
  limit = 20,
): string {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return "No messages in history.";
  const lower = query.toLowerCase();
  const matches = history.filter(
    (m) =>
      m.text.toLowerCase().includes(lower) ||
      m.senderName.toLowerCase().includes(lower),
  );
  if (matches.length === 0) return `No messages matching "${query}".`;
  return matches.slice(-limit).map(formatMessage).join("\n");
}

export function getMessagesByUser(
  chatId: string,
  userName: string,
  limit = 20,
): string {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return "No messages in history.";
  const lower = userName.toLowerCase();
  const matches = history.filter((m) =>
    m.senderName.toLowerCase().includes(lower),
  );
  if (matches.length === 0) return `No messages from "${userName}".`;
  return matches.slice(-limit).map(formatMessage).join("\n");
}

export function getMessageById(chatId: string, msgId: number): string {
  const history = chatHistories.get(chatId);
  if (!history) return "No messages in history.";
  const msg = history.find((m) => m.msgId === msgId);
  if (!msg) return `Message ${msgId} not found in recent history.`;
  return formatMessage(msg);
}

export function getKnownUsers(chatId: string): string {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return "No users seen yet.";
  const users = new Map<
    number,
    { name: string; lastSeen: number; messageCount: number }
  >();
  for (const m of history) {
    const existing = users.get(m.senderId);
    if (!existing || m.timestamp > existing.lastSeen) {
      users.set(m.senderId, {
        name: m.senderName,
        lastSeen: m.timestamp,
        messageCount: (existing?.messageCount ?? 0) + 1,
      });
    } else {
      existing.messageCount++;
    }
  }
  const lines = [...users.entries()]
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .map(([id, u]) => {
      const ago = formatRelativeAge(u.lastSeen);
      return `${u.name} (user_id: ${id}) — ${u.messageCount} msgs, last seen ${ago}`;
    });
  return lines.join("\n");
}


export function getRecentBySenderId(
  chatId: string,
  senderId: number,
  limit = 5,
): HistoryMessage[] {
  const history = chatHistories.get(chatId);
  if (!history) return [];
  const matches = history.filter((m) => m.senderId === senderId);
  return matches.slice(-limit);
}

export function getLatestMessageId(chatId: string): number | undefined {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return undefined;
  return history[history.length - 1].msgId;
}

export function getHistoryStats(chatId: string): {
  totalMessages: number;
  uniqueUsers: number;
  oldestTimestamp: number;
  newestTimestamp: number;
} {
  const history = chatHistories.get(chatId) ?? [];
  const users = new Set(history.map((m) => m.senderId));
  return {
    totalMessages: history.length,
    uniqueUsers: users.size,
    oldestTimestamp: history[0]?.timestamp ?? 0,
    newestTimestamp: history[history.length - 1]?.timestamp ?? 0,
  };
}
