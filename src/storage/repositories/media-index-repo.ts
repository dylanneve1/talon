/**
 * Media-index repository — every SQL statement that touches the
 * `media_index` table lives here, and nowhere else. The public store
 * (storage/media-index.ts) holds the domain API, formatting and the
 * expiry sweep's file deletion; this module owns the statements and
 * the row↔domain mapping.
 *
 * (chat_id, msg_id) is the primary key — the legacy store's "id"
 * string was `chatId:msgId`, reconstructed here on read. Indexes back
 * each real lookup pattern: recent-by-chat, by-chat-and-type, and the
 * timestamp-only scan the expiry sweep does (see schema.ts).
 */

import { getDatabase, inTransaction } from "../db.js";
import type { MediaEntry } from "../media-index.js";

type Row = {
  chat_id: string;
  msg_id: number;
  sender_name: string;
  type: string;
  file_path: string;
  caption: string | null;
  timestamp: number;
};

const COLUMNS =
  "chat_id, msg_id, sender_name, type, file_path, caption, timestamp";

function rowToEntry(row: Row): MediaEntry {
  return {
    id: `${row.chat_id}:${row.msg_id}`,
    chatId: row.chat_id,
    msgId: row.msg_id,
    senderName: row.sender_name,
    type: row.type as MediaEntry["type"],
    filePath: row.file_path,
    caption: row.caption ?? undefined,
    timestamp: row.timestamp,
  };
}

/** Insert-or-replace keyed by (chat_id, msg_id) — re-downloads dedupe. */
export function upsert(entry: Omit<MediaEntry, "id">): void {
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO media_index (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.chatId,
      entry.msgId,
      entry.senderName,
      entry.type,
      entry.filePath,
      entry.caption ?? null,
      entry.timestamp,
    );
}

/** Bulk-upsert inside one transaction (legacy JSON import). */
export function upsertMany(entries: Array<Omit<MediaEntry, "id">>): number {
  return inTransaction(() => {
    for (const entry of entries) upsert(entry);
    return entries.length;
  });
}

/**
 * Most-recent media for a chat, newest first. Ties on timestamp keep
 * insertion order (rowid ASC) to match the legacy stable sort.
 */
export function recentByChat(chatId: string, limit: number): MediaEntry[] {
  const rows = getDatabase()
    .prepare(
      `SELECT ${COLUMNS} FROM media_index
       WHERE chat_id = ? ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
    )
    .all(chatId, limit) as Row[];
  return rows.map(rowToEntry);
}

export function byType(
  chatId: string,
  type: MediaEntry["type"],
  limit: number,
): MediaEntry[] {
  const rows = getDatabase()
    .prepare(
      `SELECT ${COLUMNS} FROM media_index
       WHERE chat_id = ? AND type = ?
       ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
    )
    .all(chatId, type, limit) as Row[];
  return rows.map(rowToEntry);
}

/** Entries older than `cutoff` — selected so the sweep can unlink files. */
export function olderThan(cutoff: number): MediaEntry[] {
  const rows = getDatabase()
    .prepare(`SELECT ${COLUMNS} FROM media_index WHERE timestamp < ?`)
    .all(cutoff) as Row[];
  return rows.map(rowToEntry);
}

/** Delete entries older than `cutoff`; returns the number removed. */
export function deleteOlderThan(cutoff: number): number {
  const result = getDatabase()
    .prepare("DELETE FROM media_index WHERE timestamp < ?")
    .run(cutoff) as { changes: number | bigint };
  return Number(result.changes);
}

/** WAL → main-file compaction; used on shutdown. */
export function checkpoint(): void {
  getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
