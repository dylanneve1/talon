/**
 * Chat-settings repository — every SQL statement that touches the
 * `chat_settings` table lives here, and nowhere else. The public store
 * (storage/chat-settings.ts) holds the domain API and the in-memory
 * write-through cache; this module owns the statements.
 *
 * One JSON document per chat (see schema.ts migration 2): the access
 * pattern is whole-record get/set, so a keyed JSON value column is the
 * right shape — settings evolve frequently and no field is queried
 * independently in SQL.
 */

import { getDatabase, inTransaction } from "../db.js";
import type { ChatSettings } from "../chat-settings.js";

export function upsert(chatId: string, settings: ChatSettings): void {
  getDatabase()
    .prepare(
      "INSERT OR REPLACE INTO chat_settings (chat_id, settings) VALUES (?, ?)",
    )
    .run(chatId, JSON.stringify(settings));
}

/** Bulk-upsert inside one transaction (legacy JSON import). */
export function upsertMany(
  entries: Array<{ chatId: string; settings: ChatSettings }>,
): number {
  return inTransaction(() => {
    for (const { chatId, settings } of entries) upsert(chatId, settings);
    return entries.length;
  });
}

/**
 * Every persisted chat's settings — used to prime the in-memory cache.
 * Rows whose JSON fails to parse are skipped (defensive; nothing
 * should ever write malformed JSON through upsert()).
 */
export function all(): Array<{ chatId: string; settings: ChatSettings }> {
  const rows = getDatabase()
    .prepare("SELECT chat_id, settings FROM chat_settings")
    .all() as Array<{ chat_id: string; settings: string }>;
  const result: Array<{ chatId: string; settings: ChatSettings }> = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.settings) as ChatSettings;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        result.push({ chatId: row.chat_id, settings: parsed });
      }
    } catch {
      /* skip unparseable row */
    }
  }
  return result;
}

export function remove(chatId: string): void {
  getDatabase()
    .prepare("DELETE FROM chat_settings WHERE chat_id = ?")
    .run(chatId);
}

/** WAL → main-file compaction; used on shutdown. */
export function checkpoint(): void {
  getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
}
