/**
 * Kv repository — executes the statements in sql/kv.sql against the
 * `kv` table; no SQL text lives here. The public store (storage/kv.ts)
 * owns (de)serialisation and error handling.
 */

import { getDatabase } from "../db.js";
import { kvSql } from "../sql/statements.generated.js";

export function get(key: string): string | undefined {
  const row = getDatabase().prepare(kvSql.get).get(key) as
    { value: string } | undefined;
  return row?.value;
}

export function set(key: string, value: string, updatedAt: number): void {
  getDatabase().prepare(kvSql.set).run(key, value, updatedAt);
}

export function remove(key: string): boolean {
  const result = getDatabase().prepare(kvSql.remove).run(key) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}
