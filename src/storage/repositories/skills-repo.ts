/**
 * Skills repository — executes the statements in sql/skills.sql
 * against the `skills` table; no SQL text lives here. The public
 * store (storage/skill-store.ts) holds the domain API, validation,
 * and the on-disk script files; this module owns statement execution
 * and the row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { skillsSql } from "../sql/statements.generated.js";
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
    .prepare(skillsSql.upsert)
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
  const row = getDatabase().prepare(skillsSql.getByName).get(name) as
    | Row
    | undefined;
  return row ? rowToSkill(row) : undefined;
}

/** Every skill, most recently used (then most recently updated) first. */
export function all(): Skill[] {
  const rows = getDatabase().prepare(skillsSql.all).all() as Row[];
  return rows.map(rowToSkill);
}

export function count(): number {
  const row = getDatabase().prepare(skillsSql.count).get() as { n: number };
  return row.n;
}

export function recordUse(name: string, when: number): void {
  getDatabase().prepare(skillsSql.recordUse).run(when, name);
}

export function removeByName(name: string): boolean {
  const result = getDatabase().prepare(skillsSql.removeByName).run(name) as {
    changes?: number;
  };
  return (result.changes ?? 0) > 0;
}
