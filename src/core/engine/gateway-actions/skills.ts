/**
 * Skills — markdown workflows (global, not chat-scoped).
 * save / list / find / read / delete.
 */

import { dirname } from "node:path";
import {
  deleteSkill,
  formatSkill,
  formatSkillSearchResult,
  listSkills,
  readSkill,
  saveSkill,
  searchSkills,
  validateSkillBody,
  validateSkillDescription,
  validateSkillName,
} from "../../../storage/skill-store.js";
import { log } from "../../../util/log.js";
import type { SharedActionHandlers } from "./types.js";

export const skillHandlers: SharedActionHandlers = {
  save_skill: (body) => {
    const name = String(body.name ?? "").trim();
    const description = String(body.description ?? "").trim();
    const skillBody = String(body.body ?? "");

    const nameErr = validateSkillName(name);
    if (nameErr) return { ok: false, error: nameErr };
    const descErr = validateSkillDescription(description);
    if (descErr) return { ok: false, error: descErr };
    const bodyErr = validateSkillBody(skillBody);
    if (bodyErr) return { ok: false, error: bodyErr };

    const existed = Boolean(readSkill(name));
    let skill;
    try {
      skill = saveSkill({ name, description, body: skillBody });
    } catch (err) {
      return {
        ok: false,
        error: `Failed to save skill: ${err instanceof Error ? err.message : err}`,
      };
    }
    log("gateway", `save_skill: "${name}"`);
    return {
      ok: true,
      text:
        `${existed ? "Updated" : "Saved"} skill "${name}"\n` +
        `SKILL.md: ${skill.path}\n` +
        `Bundle supporting files alongside it in that folder if needed.\n` +
        `Load it with read_skill(name="${name}").`,
    };
  },

  list_skills: () => {
    const skills = listSkills();
    if (skills.length === 0)
      return {
        ok: true,
        text: "No skills saved yet. Use save_skill to store a reusable markdown workflow.",
      };
    return {
      ok: true,
      text: `Skills (${skills.length}):\n${skills.map(formatSkill).join("\n")}`,
    };
  },

  find_skills: (body) => {
    const query = String(body.query ?? "").trim();
    if (!query) return { ok: false, error: "Missing query" };
    const limit = Math.min(50, Math.max(1, Number(body.limit ?? 10)));
    const results = searchSkills(query, limit);
    if (results.length === 0)
      return {
        ok: true,
        text: `No skills matched "${query}". Use list_skills to browse all saved workflows.`,
      };
    return {
      ok: true,
      text:
        `Skill matches for "${query}" (${results.length}):\n` +
        results.map(formatSkillSearchResult).join("\n"),
    };
  },

  read_skill: (body) => {
    const name = String(body.name ?? "").trim();
    if (!name) return { ok: false, error: "Missing name" };
    const skill = readSkill(name);
    if (!skill)
      return {
        ok: false,
        error: `No skill named "${name}". See list_skills.`,
      };
    const skillDirPath = dirname(skill.path);
    const lines = [
      `# ${skill.name}`,
      "",
      skill.description,
      "",
      `Path: ${skill.path}`,
    ];
    if (skill.resources.length > 0) {
      lines.push(
        `Bundled files (read with the Read tool from ${skillDirPath}): ${skill.resources.join(", ")}`,
      );
    }
    lines.push("", skill.body);
    return { ok: true, text: lines.join("\n") };
  },

  delete_skill: (body) => {
    const name = String(body.name ?? "").trim();
    if (!name) return { ok: false, error: "Missing name" };
    if (!deleteSkill(name))
      return { ok: false, error: `No skill named "${name}"` };
    return { ok: true, text: `Deleted skill "${name}".` };
  },
};
