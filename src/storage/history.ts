/**
 * Group message history. Stores messages from all users so the agent
 * has full conversation context even for messages that didn't trigger
 * the bot.
 *
 * Backed by SQLite with an FTS5 full-text index (see
 * repositories/history-repo.ts for the statements; this module holds
 * the domain API and formatting — no SQL here). Compared to the JSON
 * buffer this replaces:
 *   - retention is unbounded — no 500-message cap, because nothing is
 *     held in process memory and reads are indexed
 *   - searchHistory is real full-text search (FTS5), not a linear
 *     `includes()` scan over the tail
 *   - writes are transactional rows, not rewrite-the-file-on-flush
 *
 * The legacy ~/.talon/data/history.json (JsonStore envelope or bare
 * pre-envelope shape) is imported once on first load, then renamed to
 * history.json.imported.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { log, logError } from "../util/log.js";
import { files } from "../util/paths.js";
import { formatSmartTimestamp, formatRelativeAge } from "../util/time.js";
import * as repo from "./repositories/history-repo.js";

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

// ── Persistence lifecycle ───────────────────────────────────────────────────

/**
 * Run the one-time import of the legacy JSON buffer and report
 * readiness. Idempotent; called once at boot.
 */
export function loadHistory(): void {
  try {
    importLegacyJson();
    const chats = repo.distinctChatCount();
    if (chats > 0) log("history", `History ready (${chats} chat(s))`);
  } catch (err) {
    logError("history", "History load failed", err);
  }
}

/**
 * Legacy JsonStore envelope ({schemaVersion, savedAt, data}) or the
 * even older bare Record<chatId, HistoryMessage[]> shape.
 */
function importLegacyJson(): void {
  // Test isolation: suites that don't mock HOME would otherwise rename
  // the user's REAL legacy JSON during import (observed live). The
  // vitest setup sets this; import-testing suites unset it locally.
  if (process.env.TALON_DISABLE_LEGACY_IMPORT === "1") return;
  const legacyPath = files.history;
  if (!existsSync(legacyPath)) return;
  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as Record<
      string,
      unknown
    >;
    const data = (
      raw && typeof raw === "object" && "data" in raw ? raw.data : raw
    ) as Record<string, HistoryMessage[]>;

    const entries: Array<{ chatId: string; msg: HistoryMessage }> = [];
    for (const [chatId, messages] of Object.entries(data ?? {})) {
      if (!Array.isArray(messages)) continue;
      for (const msg of messages) {
        if (typeof msg?.msgId !== "number" || typeof msg?.text !== "string")
          continue;
        entries.push({ chatId, msg });
      }
    }
    const imported = repo.insertMany(entries);
    renameSync(legacyPath, `${legacyPath}.imported`);
    log(
      "history",
      `Imported ${imported} message(s) from legacy history.json into SQLite`,
    );
  } catch (err) {
    logError("history", "Legacy history import failed", err);
  }
}

/**
 * SQLite commits on every write — there is no dirty buffer to flush.
 * Kept for the shutdown path: compacts the WAL into the main file.
 */
export function flushHistory(): void {
  try {
    repo.checkpoint();
  } catch {
    /* shutting down — best effort */
  }
}

// ── Core operations ─────────────────────────────────────────────────────────

export function pushMessage(chatId: string, msg: HistoryMessage): void {
  try {
    repo.insert(chatId, msg);
  } catch (err) {
    logError("history", "Failed to persist message", err);
  }
}

export function getRecentHistory(chatId: string, limit = 50): HistoryMessage[] {
  return repo.recent(chatId, limit);
}

/** Update a message's file path after media download. */
export function setMessageFilePath(
  chatId: string,
  msgId: number,
  filePath: string,
): void {
  repo.setFilePath(chatId, msgId, filePath);
}

export function clearHistory(chatId: string): void {
  repo.deleteChat(chatId);
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

/**
 * Build an FTS5 MATCH expression from free-form user input. Every
 * token is double-quoted so FTS operators (AND, NEAR, *, ^) in user
 * text are treated as literals, not syntax.
 */
function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");
}

/** Legacy contract: empty chats answer "No messages in history." */
function chatIsEmpty(chatId: string): boolean {
  return repo.latestMsgId(chatId) === undefined;
}

export function searchHistory(
  chatId: string,
  query: string,
  limit = 20,
): string {
  if (chatIsEmpty(chatId)) return "No messages in history.";
  const match = ftsQuery(query);
  if (!match) return `No messages matching "${query}".`;
  let messages: HistoryMessage[];
  try {
    messages = repo.searchFts(chatId, match, limit);
  } catch (err) {
    logError("history", `FTS search failed for ${JSON.stringify(query)}`, err);
    return `No messages matching "${query}".`;
  }
  if (messages.length === 0) return `No messages matching "${query}".`;
  return messages.map(formatMessage).join("\n");
}

export function getMessagesByUser(
  chatId: string,
  userName: string,
  limit = 20,
): string {
  if (chatIsEmpty(chatId)) return "No messages in history.";
  const messages = repo.bySenderName(chatId, userName, limit);
  if (messages.length === 0) return `No messages from "${userName}".`;
  return messages.map(formatMessage).join("\n");
}

export function getMessageById(chatId: string, msgId: number): string {
  if (chatIsEmpty(chatId)) return "No messages in history.";
  const msg = repo.byMsgId(chatId, msgId);
  if (!msg) return `Message ${msgId} not found in recent history.`;
  return formatMessage(msg);
}

export function getKnownUsers(chatId: string): string {
  const users = repo.knownUsers(chatId);
  if (users.length === 0) return "No users seen yet.";
  return users
    .map(
      (u) =>
        `${u.name} (user_id: ${u.senderId}) — ${u.messageCount} msgs, last seen ${formatRelativeAge(u.lastSeen)}`,
    )
    .join("\n");
}

export function getRecentBySenderId(
  chatId: string,
  senderId: number,
  limit = 5,
): HistoryMessage[] {
  return repo.bySenderId(chatId, senderId, limit);
}

export function getLatestMessageId(chatId: string): number | undefined {
  return repo.latestMsgId(chatId);
}

export function getHistoryStats(chatId: string): repo.ChatStats {
  return repo.statsByChat(chatId);
}
