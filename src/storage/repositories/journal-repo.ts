/**
 * Journal repository — executes the statements in sql/journal.sql
 * against the `journal` table; no SQL text lives here. The public store
 * (storage/journal.ts) owns (de)serialisation and error handling.
 */

import { getDatabase } from "../db.js";
import { journalSql } from "../sql/statements.generated.js";

export interface JournalRow {
  seq: number;
  at: number;
  type: string;
  payload: string;
}

export function append(at: number, type: string, payload: string): void {
  getDatabase().prepare(journalSql.append).run(at, type, payload);
}

export function recent(limit: number): JournalRow[] {
  return getDatabase().prepare(journalSql.recent).all(limit) as JournalRow[];
}

export function recentByType(type: string, limit: number): JournalRow[] {
  return getDatabase()
    .prepare(journalSql.recentByType)
    .all(type, limit) as JournalRow[];
}

export function prune(keep: number): void {
  getDatabase().prepare(journalSql.prune).run(keep);
}

export function count(): number {
  const row = getDatabase().prepare(journalSql.count).get() as { n: number };
  return row.n;
}
