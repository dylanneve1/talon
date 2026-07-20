/**
 * Scripts repository — executes the statements in sql/scripts.sql
 * against the `scripts` table; no SQL text lives here. The public
 * store (storage/script-store.ts) holds the domain API, validation,
 * and the on-disk script files; this module owns statement execution
 * and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { scriptsSql } from "../sql/statements.generated.js";
export type ScriptLanguage = "bash" | "python" | "node";

/** One saved script as the domain sees it. */
export type Script = {
  id: string;
  /** Unique lookup key — also the script's filename stem. */
  name: string;
  /** One-liner shown in listings; tells the agent when to reach for it. */
  description: string;
  language: ScriptLanguage;
  scriptPath: string;
  createdAt: number;
  updatedAt: number;
  useCount: number;
  lastUsedAt?: number;
};

type Row = {
  id: string;
  name: string;
  description: string;
  language: string;
  script_path: string;
  created_at: number;
  updated_at: number;
  use_count: number;
  last_used_at: number | null;
};

function rowToScript(row: Row): Script {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    language: row.language as ScriptLanguage,
    scriptPath: row.script_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

export function upsert(script: Script): void {
  getDatabase()
    .prepare(scriptsSql.upsert)
    .run(
      script.id,
      script.name,
      script.description,
      script.language,
      script.scriptPath,
      script.createdAt,
      script.updatedAt,
      script.useCount,
      script.lastUsedAt ?? null,
    );
}

export function getByName(name: string): Script | undefined {
  const row = getDatabase().prepare(scriptsSql.getByName).get(name) as
    Row | undefined;
  return row ? rowToScript(row) : undefined;
}

/** Every script, most recently used (then most recently updated) first. */
export function all(): Script[] {
  const rows = getDatabase().prepare(scriptsSql.all).all() as Row[];
  return rows.map(rowToScript);
}

export function count(): number {
  const row = getDatabase().prepare(scriptsSql.count).get() as { n: number };
  return row.n;
}

export function recordUse(name: string, when: number): void {
  getDatabase().prepare(scriptsSql.recordUse).run(when, name);
}

export function removeByName(name: string): boolean {
  const result = getDatabase().prepare(scriptsSql.removeByName).run(name) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}
