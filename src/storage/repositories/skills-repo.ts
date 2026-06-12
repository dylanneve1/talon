/**
 * Skills repository — every SQL statement that touches the `skills`
 * table lives here, and nowhere else. The public store
 * (storage/skill-store.ts) holds the domain API, validation, and the
 * on-disk script files; this module owns the statements and the
 * row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import type { Skill, SkillLanguage } from "../skill-store.js";

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

const COLUMNS =
  "id, name, description, language, script_path, created_at, updated_at, " +
  "use_count, last_used_at";

function rowToSkill(row: Row): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    language: row.language as SkillLanguage,
    scriptPath: row.script_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at ?? undefined,
  };
}

export function upsert(skill: Skill): void {
  getDatabase()
    .prepare(
      `INSERT OR REPLACE INTO skills (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      skill.id,
      skill.name,
      skill.description,
      skill.language,
      skill.scriptPath,
      skill.createdAt,
      skill.updatedAt,
      skill.useCount,
      skill.lastUsedAt ?? null,
    );
}

export function getByName(name: string): Skill | undefined {
  const row = getDatabase()
    .prepare(`SELECT ${COLUMNS} FROM skills WHERE name = ?`)
    .get(name) as Row | undefined;
  return row ? rowToSkill(row) : undefined;
}

/** Every skill, most recently used (then most recently updated) first. */
export function all(): Skill[] {
  const rows = getDatabase()
    .prepare(
      `SELECT ${COLUMNS} FROM skills
       ORDER BY last_used_at DESC NULLS LAST, updated_at DESC`,
    )
    .all() as Row[];
  return rows.map(rowToSkill);
}

export function count(): number {
  const row = getDatabase()
    .prepare("SELECT COUNT(*) AS n FROM skills")
    .get() as { n: number };
  return row.n;
}

export function recordUse(name: string, when: number): void {
  getDatabase()
    .prepare(
      "UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE name = ?",
    )
    .run(when, name);
}

export function removeByName(name: string): boolean {
  const result = getDatabase()
    .prepare("DELETE FROM skills WHERE name = ?")
    .run(name) as { changes?: number };
  return (result.changes ?? 0) > 0;
}
