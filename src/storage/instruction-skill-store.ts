/**
 * Instruction skill store — reusable markdown workflow bundles.
 *
 * These are distinct from executable `save_skill` scripts. Instruction
 * skills are guidance the agent can load into context when a repeatable
 * workflow needs judgement: review protocols, release checklists,
 * backend-specific debugging procedures, and similar reusable know-how.
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
import { resolve } from "node:path";
import { dirs } from "../util/paths.js";

export type InstructionSkill = {
  name: string;
  description: string;
  body: string;
  path: string;
  updatedAt: number;
};

export type InstructionSkillSearchResult = {
  skill: InstructionSkill;
  score: number;
  snippet: string;
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const DESCRIPTION_MAX_CHARS = 300;
const BODY_MAX_BYTES = 128 * 1024;
const PROMPT_LIST_LIMIT = 25;
const SEARCH_RESULT_LIMIT = 10;

export function instructionSkillsDir(): string {
  return resolve(dirs.workspace, "instruction-skills");
}

export function instructionSkillPath(name: string): string {
  return resolve(instructionSkillsDir(), `${name}.md`);
}

export function validateInstructionSkillName(name: string): string | null {
  if (!name) return "Missing name";
  if (!NAME_RE.test(name))
    return "Name must be 1-64 chars of letters, digits, dash, underscore (it becomes the markdown filename)";
  return null;
}

export function validateInstructionSkillDescription(
  description: string,
): string | null {
  if (!description || !description.trim()) return "Missing description";
  if (description.length > DESCRIPTION_MAX_CHARS)
    return `Description too long (max ${DESCRIPTION_MAX_CHARS} chars)`;
  return null;
}

export function validateInstructionSkillBody(body: string): string | null {
  if (!body || !body.trim()) return "Missing instruction body";
  if (Buffer.byteLength(body, "utf-8") > BODY_MAX_BYTES)
    return `Instruction body too large (max ${BODY_MAX_BYTES} bytes)`;
  return null;
}

function escapeFrontMatter(value: string): string {
  return JSON.stringify(value);
}

function unquoteFrontMatter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function serializeInstructionSkill(input: {
  name: string;
  description: string;
  body: string;
}): string {
  return [
    "---",
    `name: ${escapeFrontMatter(input.name)}`,
    `description: ${escapeFrontMatter(input.description)}`,
    "---",
    "",
    input.body.trimEnd(),
    "",
  ].join("\n");
}

function parseInstructionSkill(path: string, raw: string): InstructionSkill {
  const fallbackName = path.split("/").pop()?.replace(/\.md$/, "") ?? "";
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

  const header = raw.slice(4, end).trim();
  const body = raw.slice(end + "\n---".length).trim();
  let name = fallbackName;
  let description = "";
  for (const line of header.split("\n")) {
    const [key, ...rest] = line.split(":");
    const value = rest.join(":");
    if (key.trim() === "name") name = unquoteFrontMatter(value);
    if (key.trim() === "description") description = unquoteFrontMatter(value);
  }
  return { name, description, body, path, updatedAt: 0 };
}

export function saveInstructionSkill(input: {
  name: string;
  description: string;
  body: string;
}): InstructionSkill {
  const dir = instructionSkillsDir();
  mkdirSync(dir, { recursive: true });
  const path = instructionSkillPath(input.name);
  const content = serializeInstructionSkill(input);
  writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
  return readInstructionSkill(input.name)!;
}

export function readInstructionSkill(
  name: string,
): InstructionSkill | undefined {
  const path = instructionSkillPath(name);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf-8");
  const skill = parseInstructionSkill(path, raw);
  try {
    skill.updatedAt = Math.floor(statSync(path).mtimeMs);
  } catch {
    skill.updatedAt = 0;
  }
  return skill;
}

export function listInstructionSkills(): InstructionSkill[] {
  const dir = instructionSkillsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((file) => readInstructionSkill(file.replace(/\.md$/, "")))
    .filter((skill): skill is InstructionSkill => Boolean(skill))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function scoreInstructionSkill(
  skill: InstructionSkill,
  tokens: string[],
): number {
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

function snippetFor(skill: InstructionSkill, tokens: string[]): string {
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

export function searchInstructionSkills(
  query: string,
  limit = SEARCH_RESULT_LIMIT,
): InstructionSkillSearchResult[] {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];
  return listInstructionSkills()
    .map((skill) => ({
      skill,
      score: scoreInstructionSkill(skill, tokens),
      snippet: snippetFor(skill, tokens),
    }))
    .filter((result) => result.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
    )
    .slice(0, Math.max(1, Math.min(50, limit)));
}

export function deleteInstructionSkill(name: string): boolean {
  const path = instructionSkillPath(name);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function formatInstructionSkill(skill: InstructionSkill): string {
  const updated = skill.updatedAt
    ? new Date(skill.updatedAt).toISOString().slice(0, 10)
    : "unknown";
  return `- ${skill.name} (updated ${updated}) — ${skill.description}`;
}

export function formatInstructionSkillSearchResult(
  result: InstructionSkillSearchResult,
): string {
  const base = `${formatInstructionSkill(result.skill)} (score ${result.score})`;
  if (!result.snippet) return base;
  return `${base}\n  ${result.snippet}`;
}

export function renderInstructionSkillsPrompt(): string {
  const skills = listInstructionSkills();
  if (skills.length === 0) return "";
  const visible = skills.slice(0, PROMPT_LIST_LIMIT);
  const hidden = skills.length - visible.length;
  const lines = [
    "## Available Instruction Skills",
    "",
    "Instruction skills are reusable markdown workflows. Use `find_instruction_skills` when the relevant workflow is not obvious, then load the full body with `read_instruction_skill` before following one; do not guess from the description alone.",
    "",
    ...visible.map(formatInstructionSkill),
  ];
  if (hidden > 0) {
    lines.push(`- ... ${hidden} more hidden; use list_instruction_skills`);
  }
  return lines.join("\n");
}
