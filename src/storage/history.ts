/**
 * Group message history buffer. Stores recent messages from all users
 * so Claude has full conversation context even for messages that didn't
 * trigger the bot.
 *
 * Persisted via the unified `JsonStore<T>` envelope at
 * `~/.talon/data/history.json`. A migrate hook accepts the
 * pre-envelope bare-object shape (`Record<chatId, HistoryMessage[]>`)
 * so existing on-disk state loads unchanged. Survives restarts so
 * pulse, search, and group threading context don't lose state.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { files } from "../util/paths.js";
import { formatSmartTimestamp, formatRelativeAge } from "../util/time.js";
import { registerCleanup } from "../util/cleanup-registry.js";
import { JsonStore } from "../core/agent-runtime/store.js";

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

type HistoryShape = Record<string, HistoryMessage[]>;

const MAX_HISTORY_PER_CHAT = 500;
const MAX_CHAT_COUNT = 1000;
const STORE_FILE = files.history;
const SCHEMA_VERSION = 1 as const;

const store = new JsonStore<HistoryShape>({
  path: STORE_FILE,
  defaultValue: {},
  schemaVersion: SCHEMA_VERSION,
  migrate: (raw, fromVersion) => {
    if (fromVersion !== 0) return null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { value: {}, schemaVersion: SCHEMA_VERSION };
    }
    const out: HistoryShape = {};
    for (const [chatId, messages] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      if (Array.isArray(messages)) {
        out[chatId] = messages.slice(-MAX_HISTORY_PER_CHAT) as HistoryMessage[];
      }
    }
    return { value: out, schemaVersion: SCHEMA_VERSION };
  },
});

// ── Persistence ─────────────────────────────────────────────────────────────

export function loadHistory(): void {
  store.reset();
  try {
    store.loadSync();
  } catch (err) {
    logError("history", "History load failed", err);
    return;
  }
  // Cap per-chat history on load — bounds memory if the on-disk file
  // grew past the limit between runs (e.g. limit lowered in a config
  // change).
  store.update((data) => {
    for (const chatId of Object.keys(data)) {
      if (data[chatId].length > MAX_HISTORY_PER_CHAT) {
        data[chatId] = data[chatId].slice(-MAX_HISTORY_PER_CHAT);
      }
    }
  });
  const size = Object.keys(store.get()).length;
  if (size > 0) {
    log("history", `Loaded history for ${size} chat(s)`);
  }
}

function saveHistory(): void {
  if (!store.isDirty()) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    store.saveSync();
  } catch (err) {
    logError("history", "Failed to persist history", err);
    recordError(
      `History save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// Auto-save every 30 seconds (less frequent than sessions since history is larger)
const autoSaveTimer = setInterval(saveHistory, 30_000);
registerCleanup(saveHistory);

export function flushHistory(): void {
  clearInterval(autoSaveTimer);
  store.update(() => undefined);
  saveHistory();
}

// ── Core operations ─────────────────────────────────────────────────────────

export function pushMessage(chatId: string, msg: HistoryMessage): void {
  store.update((data) => {
    let history = data[chatId];
    if (!history) {
      const keys = Object.keys(data);
      if (keys.length >= MAX_CHAT_COUNT) {
        const evictCount = Math.floor(MAX_CHAT_COUNT * 0.1);
        for (let i = 0; i < evictCount; i++) {
          const oldest = keys[i];
          if (!oldest) break;
          delete data[oldest];
        }
      }
      history = [];
      data[chatId] = history;
    }
    history.push(msg);
    if (history.length > MAX_HISTORY_PER_CHAT) {
      history.splice(0, history.length - MAX_HISTORY_PER_CHAT);
    }
  });
}

export function getRecentHistory(chatId: string, limit = 50): HistoryMessage[] {
  const history = store.get()[chatId];
  if (!history) return [];
  return history.slice(-limit);
}

/** Update a message's file path after media download. */
export function setMessageFilePath(
  chatId: string,
  msgId: number,
  filePath: string,
): void {
  const existing = store.get()[chatId];
  if (!existing) return;
  if (!existing.some((m) => m.msgId === msgId)) return;
  store.update((data) => {
    const history = data[chatId];
    const msg = history.find((m) => m.msgId === msgId);
    if (msg) msg.filePath = filePath;
  });
}

export function clearHistory(chatId: string): void {
  if (!store.get()[chatId]) return;
  store.update((data) => {
    delete data[chatId];
  });
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
  const history = store.get()[chatId];
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
  const history = store.get()[chatId];
  if (!history || history.length === 0) return "No messages in history.";
  const lower = userName.toLowerCase();
  const matches = history.filter((m) =>
    m.senderName.toLowerCase().includes(lower),
  );
  if (matches.length === 0) return `No messages from "${userName}".`;
  return matches.slice(-limit).map(formatMessage).join("\n");
}

export function getMessageById(chatId: string, msgId: number): string {
  const history = store.get()[chatId];
  if (!history) return "No messages in history.";
  const msg = history.find((m) => m.msgId === msgId);
  if (!msg) return `Message ${msgId} not found in recent history.`;
  return formatMessage(msg);
}

export function getKnownUsers(chatId: string): string {
  const history = store.get()[chatId];
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
  const history = store.get()[chatId];
  if (!history) return [];
  const matches = history.filter((m) => m.senderId === senderId);
  return matches.slice(-limit);
}

export function getLatestMessageId(chatId: string): number | undefined {
  const history = store.get()[chatId];
  if (!history || history.length === 0) return undefined;
  return history[history.length - 1].msgId;
}

export function getHistoryStats(chatId: string): {
  totalMessages: number;
  uniqueUsers: number;
  oldestTimestamp: number;
  newestTimestamp: number;
} {
  const history = store.get()[chatId] ?? [];
  const users = new Set(history.map((m) => m.senderId));
  return {
    totalMessages: history.length,
    uniqueUsers: users.size,
    oldestTimestamp: history[0]?.timestamp ?? 0,
    newestTimestamp: history[history.length - 1]?.timestamp ?? 0,
  };
}
