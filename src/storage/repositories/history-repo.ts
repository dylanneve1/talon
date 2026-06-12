/**
 * History repository — executes the statements in sql/history.sql
 * against the history tables; no SQL text lives here. The public store
 * (storage/history.ts) holds the domain API and formatting; this
 * module owns statement execution and the row↔domain mapping.
 */

import { getDatabase, inTransaction } from "../db.js";
import { dbSql, historySql } from "../sql/statements.generated.js";
import type { HistoryMessage } from "../history.js";

type Row = {
  msg_id: number;
  sender_id: number;
  sender_name: string;
  text: string;
  reply_to_msg_id: number | null;
  timestamp: number;
  media_type: string | null;
  sticker_file_id: string | null;
  file_path: string | null;
};

function rowToMessage(row: Row): HistoryMessage {
  return {
    msgId: row.msg_id,
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    replyToMsgId: row.reply_to_msg_id ?? undefined,
    timestamp: row.timestamp,
    mediaType: (row.media_type ?? undefined) as HistoryMessage["mediaType"],
    stickerFileId: row.sticker_file_id ?? undefined,
    filePath: row.file_path ?? undefined,
  };
}

export function insert(chatId: string, msg: HistoryMessage): void {
  getDatabase()
    .prepare(historySql.insert)
    .run(
      chatId,
      msg.msgId,
      msg.senderId,
      msg.senderName,
      msg.text,
      msg.replyToMsgId ?? null,
      msg.timestamp,
      msg.mediaType ?? null,
      msg.stickerFileId ?? null,
      msg.filePath ?? null,
    );
}

/** Bulk-insert inside one transaction (legacy JSON import). */
export function insertMany(
  entries: Array<{ chatId: string; msg: HistoryMessage }>,
): number {
  return inTransaction(() => {
    for (const { chatId, msg } of entries) insert(chatId, msg);
    return entries.length;
  });
}

/** Most-recent `limit` messages, in chronological order. */
export function recent(chatId: string, limit: number): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.recent)
    .all(chatId, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function setFilePath(
  chatId: string,
  msgId: number,
  filePath: string,
): void {
  getDatabase().prepare(historySql.setFilePath).run(filePath, chatId, msgId);
}

export function deleteChat(chatId: string): void {
  getDatabase().prepare(historySql.deleteChat).run(chatId);
}

/**
 * FTS5 full-text search over text + sender name; `match` must already
 * be a valid FTS expression (see history.ts ftsQuery). Chronological
 * order, most recent `limit` matches.
 */
export function searchFts(
  chatId: string,
  match: string,
  limit: number,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.searchFts)
    .all(chatId, match, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function bySenderName(
  chatId: string,
  nameFragment: string,
  limit: number,
): HistoryMessage[] {
  const escaped = nameFragment
    .toLowerCase()
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  const rows = getDatabase()
    .prepare(historySql.bySenderName)
    .all(chatId, `%${escaped}%`, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function byMsgId(
  chatId: string,
  msgId: number,
): HistoryMessage | undefined {
  const row = getDatabase().prepare(historySql.byMsgId).get(chatId, msgId) as
    | Row
    | undefined;
  return row ? rowToMessage(row) : undefined;
}

export function bySenderId(
  chatId: string,
  senderId: number,
  limit: number,
): HistoryMessage[] {
  const rows = getDatabase()
    .prepare(historySql.bySenderId)
    .all(chatId, senderId, limit) as Row[];
  return rows.reverse().map(rowToMessage);
}

export function latestMsgId(chatId: string): number | undefined {
  const row = getDatabase().prepare(historySql.latestMsgId).get(chatId) as
    | { msg_id: number }
    | undefined;
  return row?.msg_id;
}

export type KnownUser = {
  senderId: number;
  name: string;
  lastSeen: number;
  messageCount: number;
};

/** Distinct senders, most recently seen first, with current name. */
export function knownUsers(chatId: string): KnownUser[] {
  const rows = getDatabase()
    .prepare(historySql.knownUsers)
    .all(chatId) as Array<{
    sender_id: number;
    last_seen: number;
    message_count: number;
    name: string;
  }>;
  return rows.map((r) => ({
    senderId: r.sender_id,
    name: r.name,
    lastSeen: r.last_seen,
    messageCount: r.message_count,
  }));
}

export type ChatStats = {
  totalMessages: number;
  uniqueUsers: number;
  oldestTimestamp: number;
  newestTimestamp: number;
};

export function statsByChat(chatId: string): ChatStats {
  const row = getDatabase().prepare(historySql.statsByChat).get(chatId) as {
    total: number;
    users: number;
    oldest: number;
    newest: number;
  };
  return {
    totalMessages: row.total,
    uniqueUsers: row.users,
    oldestTimestamp: row.oldest,
    newestTimestamp: row.newest,
  };
}

export function distinctChatCount(): number {
  const row = getDatabase().prepare(historySql.distinctChatCount).get() as {
    chats: number;
  };
  return row.chats;
}

/** WAL → main-file compaction; used on shutdown. */
export function checkpoint(): void {
  getDatabase().exec(dbSql.walCheckpoint);
}
