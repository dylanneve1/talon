/**
 * Skill store — reusable workflow bundles following Anthropic's Agent
 * Skills (SKILL.md) standard.
 *
 * These are distinct from executable `save_script` scripts. Skills are
 * guidance the agent can load into context when a repeatable workflow
 * needs judgement: review protocols, release checklists, backend-
 * specific debugging procedures, and similar reusable know-how.
 *
 * Layout: each skill is a FOLDER under `workspace/skills/<name>/`
 * containing a `SKILL.md` entry file (YAML frontmatter + markdown body).
 * The folder may also bundle supporting files (scripts, templates,
 * references) alongside SKILL.md; those are preserved across updates and
 * surfaced to the agent on read.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { dirs } from "../util/paths.js";

export type Skill = {
  name: string;
  description: string;
  body: string;
  path: string;
  updatedAt: number;
  /** Relative filenames bundled in the skill folder (excludes SKILL.md). */
  resources: string[];
  /** Frontmatter keys beyond name/description, preserved on read. */
  extra?: Record<string, unknown>;
};

export type SkillSearchResult = {
  skill: Skill;
  score: number;
  snippet: string;
};

const SKILL_FILE = "SKILL.md";
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DESCRIPTION_MAX_CHARS = 300;
const BODY_MAX_BYTES = 128 * 1024;
const PROMPT_LIST_LIMIT = 25;
const SEARCH_RESULT_LIMIT = 10;

export function skillsDir(): string {
  return resolve(dirs.workspace, "skills");
}

export function skillDir(name: string): string {
  return resolve(skillsDir(), name);
}

export function skillFilePath(name: string): string {
  return resolve(skillDir(name), SKILL_FILE);
}

/**
 * Path to a skill's SKILL.md entry file. Retained under the historical
 * `skillPath` name for callers that reference it.
 */
export function skillPath(name: string): string {
  return skillFilePath(name);
}

export function validateSkillName(name: string): string | null {
  if (!name) return "Missing name";
  if (!NAME_RE.test(name))
    return "Name must be 1-64 chars of letters, digits, dash, underscore (it becomes the skill folder name)";
  return null;
}

export function validateSkillDescription(description: string): string | null {
  if (!description || !description.trim()) return "Missing description";
  if (description.length > DESCRIPTION_MAX_CHARS)
    return `Description too long (max ${DESCRIPTION_MAX_CHARS} chars)`;
  return null;
}

export function validateSkillBody(body: string): string | null {
  if (!body || !body.trim()) return "Missing instruction body";
  if (Buffer.byteLength(body, "utf-8") > BODY_MAX_BYTES)
    return `Instruction body too large (max ${BODY_MAX_BYTES} bytes)`;
  return null;
}

function serializeSkill(input: {
  name: string;
  description: string;
  body: string;
  extra?: Record<string, unknown>;
}): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    description: input.description,
    ...input.extra,
  };
  // Keep name/description first; stringify preserves insertion order.
  const yaml = stringify(frontmatter).trimEnd();
  return ["---", yaml, "---", "", input.body.trimEnd(), ""].join("\n");
}

function parseSkill(path: string, raw: string): Omit<Skill, "resources"> {
  const fallbackName = basename(resolve(path, ".."));
  if (!raw.startsWith("---\n")) {
    return {
      name: fallbackName,
      description: "",
      body: raw.trim(),
      path,
      updatedAt: 0,
    };
  }

  const end = raw.indexOf("\n---", 4);
  if (end < 0) {
    return {
      name: fallbackName,
      description: "",
      body: raw.trim(),
      path,
      updatedAt: 0,
    };
  }

  const header = raw.slice(4, end);
  const body = raw
    .slice(end + "\n---".length)
    .replace(/^\n/, "")
    .trimEnd();

  let parsed: Record<string, unknown> = {};
  try {
    const value = parseDocument(header).toJS();
    if (value && typeof value === "object") {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const name =
    typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name
      : fallbackName;
  const description =
    typeof parsed.description === "string" ? parsed.description : "";

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "name" || key === "description") continue;
    extra[key] = value;
  }

  return {
    name,
    description,
    body,
    path,
    updatedAt: 0,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

function listResources(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== SKILL_FILE)
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export function saveSkill(input: {
  name: string;
  description: string;
  body: string;
  extra?: Record<string, unknown>;
}): Skill {
  const dir = skillDir(input.name);
  // Recursive mkdir preserves any sibling bundled files on update; we
  // only overwrite SKILL.md, never the rest of the folder.
  mkdirSync(dir, { recursive: true });
  const path = skillFilePath(input.name);
  const content = serializeSkill(input);
  writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
  return readSkill(input.name)!;
}

export function readSkill(name: string): Skill | undefined {
  // Reject names that fail validation (e.g. "../escape") before they
  // are turned into a filesystem path — guards against path traversal.
  if (validateSkillName(name)) return undefined;
  const dir = skillDir(name);
  const path = skillFilePath(name);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  const parsed = parseSkill(path, raw);
  const skill: Skill = { ...parsed, resources: listResources(dir) };
  try {
    skill.updatedAt = Math.floor(statSync(path).mtimeMs);
  } catch {
    skill.updatedAt = 0;
  }
  return skill;
}

export function listSkills(): Skill[] {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(resolve(dir, entry.name, SKILL_FILE)))
    .map((entry) => readSkill(entry.name))
    .filter((skill): skill is Skill => Boolean(skill))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreSkill(skill: Skill, tokens: string[]): number {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const body = skill.body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name === token) score += 20;
    else if (name.includes(token)) score += 12;
    if (description.includes(token)) score += 6;
    if (body.includes(token)) score += 2;
  }
  return score;
}

function snippetFor(skill: Skill, tokens: string[]): string {
  const body = skill.body.replace(/\s+/g, " ").trim();
  if (!body) return "";
  const lower = body.toLowerCase();
  const hit = tokens
    .map((token) => lower.indexOf(token))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (hit ?? 0) - 80);
  const end = Math.min(body.length, start + 220);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < body.length ? "..." : "";
  return `${prefix}${body.slice(start, end)}${suffix}`;
}

export function searchSkills(
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): SkillSearchResult[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  return listSkills()
    .map((skill) => ({
      skill,
      score: scoreSkill(skill, tokens),
      snippet: snippetFor(skill, tokens),
    }))
    .filter((result) => result.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
    )
    .slice(0, Math.max(1, Math.min(50, limit)));
}

export function deleteSkill(name: string): boolean {
  // Reject names that fail validation (e.g. "../escape") before they
  // are turned into a filesystem path — guards against path traversal.
  if (validateSkillName(name)) return false;
  const dir = skillDir(name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function formatSkill(skill: Skill): string {
  const updated = skill.updatedAt
    ? new Date(skill.updatedAt).toISOString().slice(0, 10)
    : "unknown";
  return `- ${skill.name} (updated ${updated}) — ${skill.description}`;
}

export function formatSkillSearchResult(result: SkillSearchResult): string {
  const base = `${formatSkill(result.skill)} (score ${result.score})`;
  if (!result.snippet) return base;
  return `${base}\n  ${result.snippet}`;
}

export function renderSkillsPrompt(): string {
  const skills = listSkills();
  if (skills.length === 0) return "";
  const visible = skills.slice(0, PROMPT_LIST_LIMIT);
  const hidden = skills.length - visible.length;
  const lines = [
    "## Available Skills",
    "",
    "Skills are reusable workflow bundles (a `SKILL.md` per skill folder, optionally with bundled supporting files). Use `find_skills` when the relevant workflow is not obvious, then load the full body with `read_skill` before following one; do not guess from the description alone.",
    "",
    ...visible.map(formatSkill),
  ];
  if (hidden > 0) {
    lines.push(`- ... ${hidden} more hidden; use list_skills`);
  }
  return lines.join("\n");
}
