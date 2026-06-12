/**
 * Skill store — reusable, agent-authored scripts.
 *
 * A skill is a procedure the agent worked out once and saved for
 * reuse: an API call chain, a report generator, a data transform.
 * Unlike triggers (long-running watchers that wake the agent), a
 * skill is run-to-completion on demand via the `run_skill` tool and
 * its output is returned to the calling turn — local execution, zero
 * inference cost.
 *
 * Skills are global capabilities, not chat data: any chat can run a
 * skill saved in another. Metadata lives in SQLite (see
 * repositories/skills-repo.ts); the script body lives on disk at
 * ~/.talon/workspace/skills/<name>.<ext> so the agent can also Read
 * and Edit a skill like a normal workspace file (the workspace
 * listing in the system prompt makes the directory discoverable).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { dirs } from "../util/paths.js";
import * as repo from "./repositories/skills-repo.js";

export type SkillLanguage = "bash" | "python" | "node";

export type Skill = {
  id: string;
  /** Unique lookup key — also the script's filename stem. */
  name: string;
  /** One-liner shown in listings; tells the agent when to reach for it. */
  description: string;
  language: SkillLanguage;
  scriptPath: string;
  createdAt: number;
  updatedAt: number;
  useCount: number;
  lastUsedAt?: number;
};

export const SKILL_LANGUAGES: readonly SkillLanguage[] = [
  "bash",
  "python",
  "node",
];

/**
 * Stricter than the trigger name rule: a skill name doubles as its
 * script filename, so no spaces or dots.
 */
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SCRIPT_MAX_BYTES = 64 * 1024;
const DESCRIPTION_MAX_CHARS = 300;

const EXTENSIONS: Record<SkillLanguage, string> = {
  bash: "sh",
  python: "py",
  // .mjs so agent-written ESM runs as-is — the skills dir has no
  // package.json, so a bare .js would default to CommonJS.
  node: "mjs",
};

// ── Validation ──────────────────────────────────────────────────────────────

export function validateSkillLanguage(value: unknown): value is SkillLanguage {
  return (
    typeof value === "string" &&
    (SKILL_LANGUAGES as readonly string[]).includes(value)
  );
}

export function validateSkillName(name: string): string | null {
  if (!name) return "Missing name";
  if (!NAME_RE.test(name))
    return "Name must be 1-64 chars of letters, digits, dash, underscore (it becomes the script filename)";
  return null;
}

export function validateSkillScript(script: string): string | null {
  if (!script || !script.trim()) return "Missing script body";
  if (Buffer.byteLength(script, "utf-8") > SCRIPT_MAX_BYTES)
    return `Script too large (max ${SCRIPT_MAX_BYTES} bytes)`;
  return null;
}

export function validateSkillDescription(description: string): string | null {
  if (!description || !description.trim()) return "Missing description";
  if (description.length > DESCRIPTION_MAX_CHARS)
    return `Description too long (max ${DESCRIPTION_MAX_CHARS} chars)`;
  return null;
}

// ── Script files ────────────────────────────────────────────────────────────

export function skillsDir(): string {
  return resolve(dirs.workspace, "skills");
}

export function skillScriptPath(name: string, lang: SkillLanguage): string {
  return resolve(skillsDir(), `${name}.${EXTENSIONS[lang]}`);
}

/** Write a skill's script body, creating the skills dir as needed. */
export function writeSkillScript(
  name: string,
  lang: SkillLanguage,
  body: string,
): string {
  const path = skillScriptPath(name, lang);
  mkdirSync(dirname(path), { recursive: true });
  // 0o700: only the user running Talon should be able to read/exec scripts
  writeFileSync(path, body, { encoding: "utf-8", mode: 0o700 });
  return path;
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function generateSkillId(): string {
  return `skill_${randomUUID()}`;
}

/**
 * Create or replace a skill: writes the script file, then upserts the
 * metadata row. On replace, the previous script file is removed first
 * when the language (and therefore extension) changed.
 */
export function saveSkill(input: {
  name: string;
  description: string;
  language: SkillLanguage;
  script: string;
}): Skill {
  const existing = repo.getByName(input.name);
  if (existing && existing.language !== input.language) {
    try {
      rmSync(existing.scriptPath, { force: true });
    } catch {
      /* best effort */
    }
  }
  const scriptPath = writeSkillScript(input.name, input.language, input.script);
  const now = Date.now();
  const skill: Skill = {
    id: existing?.id ?? generateSkillId(),
    name: input.name,
    description: input.description,
    language: input.language,
    scriptPath,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    useCount: existing?.useCount ?? 0,
    lastUsedAt: existing?.lastUsedAt,
  };
  repo.upsert(skill);
  return skill;
}

export function getSkill(name: string): Skill | undefined {
  return repo.getByName(name);
}

export function getAllSkills(): Skill[] {
  return repo.all();
}

export function countSkills(): number {
  return repo.count();
}

export function recordSkillUse(name: string): void {
  repo.recordUse(name, Date.now());
}

/** Delete a skill and best-effort clean up its on-disk script. */
export function deleteSkill(name: string): boolean {
  const skill = repo.getByName(name);
  if (!skill) return false;
  repo.removeByName(name);
  try {
    rmSync(skill.scriptPath, { force: true });
  } catch {
    /* best effort */
  }
  return true;
}

// ── Formatting ──────────────────────────────────────────────────────────────

/** One-line listing entry shared by `list_skills` and prompt surfaces. */
export function formatSkill(skill: Skill): string {
  const used =
    skill.useCount > 0
      ? `used ${skill.useCount}×${skill.lastUsedAt ? `, last ${new Date(skill.lastUsedAt).toISOString().slice(0, 10)}` : ""}`
      : "never used";
  return `- ${skill.name} (${skill.language}, ${used}) — ${skill.description}`;
}
