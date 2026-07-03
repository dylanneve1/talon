/**
 * Turn-meta repository — executes the statements in sql/turn-meta.sql
 * against the `turn_meta` table; no SQL text lives here. The public
 * store (storage/turn-meta.ts) owns the read-merge-write and legacy
 * import; this module owns statement execution and stays
 * domain-agnostic — `meta` is opaque JSON text on the way in and out.
 */

import { getDatabase } from "../db.js";
import { turnMetaSql } from "../sql/statements.generated.js";

/** Raw meta JSON for one message, or undefined if none is stored. */
export function get(chatId: string, msgId: string): string | undefined {
  const row = getDatabase().prepare(turnMetaSql.get).get(chatId, msgId) as
    { meta: string } | undefined;
  return row?.meta;
}

/** Insert-or-replace the meta JSON for one message. */
export function upsert(chatId: string, msgId: string, metaJson: string): void {
  getDatabase().prepare(turnMetaSql.upsert).run(chatId, msgId, metaJson);
}

/** Forget a chat entirely (chat deleted / history cleared). */
export function removeChat(chatId: string): void {
  getDatabase().prepare(turnMetaSql.removeChat).run(chatId);
}

/** Retention: keep only the newest `keep` turns for one chat. */
export function prune(chatId: string, keep: number): void {
  getDatabase().prepare(turnMetaSql.prune).run(chatId, keep);
}
