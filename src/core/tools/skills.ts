/**
 * Skill tools — reusable workflow bundles following Anthropic's Agent
 * Skills (SKILL.md) standard.
 *
 * Skills are guidance the agent loads into context when a repeatable
 * workflow needs judgement: review protocols, release checklists,
 * backend-specific debugging procedures, and similar reusable know-how.
 * Unlike scripts (executable subprocesses), a skill is a SKILL.md the
 * agent reads and follows, optionally bundling supporting files in its
 * folder. Skills are global (not chat-scoped) and survive restarts.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const skillTools: ToolDefinition[] = [
  {
    name: "save_skill",
    description: `Save (or update) a reusable skill — a SKILL.md workflow bundle you can load later with read_skill. Follows Anthropic's Agent Skills standard: each skill is a folder (skills/<name>/SKILL.md) with YAML frontmatter (name, description) plus a markdown body, and may bundle supporting files (scripts, templates, references) alongside SKILL.md.

Use skills for reusable procedures that require judgement rather than subprocess execution: review protocols, debugging playbooks, backend investigation steps, release checklists, or house style instructions. They are not factual memory; store facts in memory/palace instead. Saving to an existing name overwrites SKILL.md but preserves any other files bundled in the folder.`,
    schema: {
      name: z
        .string()
        .describe(
          "Unique skill name, 1-64 chars of letters/digits/dash/underscore (becomes the skill folder name)",
        ),
      description: z
        .string()
        .describe(
          "One line: what workflow this covers and when to use it (shown in list_skills)",
        ),
      body: z
        .string()
        .describe("Full markdown instructions for the workflow (max 128KB)"),
    },
    execute: (params, bridge) => bridge("save_skill", params),
    tag: "skills",
  },

  {
    name: "list_skills",
    description:
      "List saved skills with descriptions. Check here before re-deriving a reusable workflow or process.",
    schema: {},
    execute: (_params, bridge) => bridge("list_skills", {}),
    tag: "skills",
  },

  {
    name: "find_skills",
    description:
      "Search saved skills by query and return ranked discovery results. Use this to select the relevant workflow before loading its full body with read_skill.",
    schema: {
      query: z
        .string()
        .describe(
          "Search terms describing the workflow you need, e.g. 'github review comments' or 'release checklist'",
        ),
      limit: z
        .number()
        .optional()
        .describe("Maximum results to return (default 10, max 50)"),
    },
    execute: (params, bridge) => bridge("find_skills", params),
    tag: "skills",
  },

  {
    name: "read_skill",
    description:
      "Read the full SKILL.md body for a saved skill. Load it before following that workflow; descriptions are only discovery hints. If the skill bundles supporting files in its folder, they are listed so you can open them with the Read tool.",
    schema: {
      name: z.string().describe("Skill name"),
    },
    execute: (params, bridge) => bridge("read_skill", params),
    tag: "skills",
  },

  {
    name: "delete_skill",
    description:
      "Delete a saved skill and its entire folder (SKILL.md plus any bundled files) permanently.",
    schema: {
      name: z.string().describe("Skill name to delete"),
    },
    execute: (params, bridge) => bridge("delete_skill", params),
    tag: "skills",
  },
];
