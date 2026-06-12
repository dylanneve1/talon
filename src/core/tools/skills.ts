/**
 * Skill tools — reusable agent-authored scripts and instruction bundles.
 *
 * Skills close the loop on procedures the agent works out during a
 * conversation: instead of re-deriving a multi-step pipeline (API
 * call chain, report generator, data transform) every time, the
 * agent saves it once and replays it with `run_skill` — a local
 * subprocess, zero inference cost. Skills are global (not chat-
 * scoped) and survive restarts.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const skillTools: ToolDefinition[] = [
  {
    name: "save_skill",
    description: `Save (or update) a reusable skill — a named script you can run later with run_skill.

Save a skill whenever you've worked out a multi-step procedure worth repeating: fetching and formatting a report, transforming a file, calling an API chain. Next time, run_skill replays it instantly as a local script instead of you re-deriving the steps. Scripts run with the workspace as cwd. Saving to an existing name replaces that skill.

Make scripts parameterizable: extra arguments passed to run_skill arrive as argv (bash: $1, $2…; python: sys.argv; node: process.argv).`,
    schema: {
      name: z
        .string()
        .describe(
          "Unique skill name, 1-64 chars of letters/digits/dash/underscore (becomes the script filename)",
        ),
      description: z
        .string()
        .describe(
          "One line: what it does and when to use it (shown in list_skills)",
        ),
      language: z.enum(["bash", "python", "node"]).describe("Script language"),
      script: z.string().describe("Full script body (max 64KB)"),
    },
    execute: (params, bridge) => bridge("save_skill", params),
    tag: "skills",
  },

  {
    name: "list_skills",
    description:
      "List all saved skills with language, usage stats, and descriptions. Check here before hand-writing a procedure you may have already saved.",
    schema: {},
    execute: (_params, bridge) => bridge("list_skills", {}),
    tag: "skills",
  },

  {
    name: "run_skill",
    description:
      "Run a saved skill to completion and get its output (stdout/stderr/exit code). Local script execution — fast and free. Pass args to parameterize (they arrive as the script's argv).",
    schema: {
      name: z.string().describe("Skill name (see list_skills)"),
      args: z
        .array(z.string())
        .optional()
        .describe("Arguments passed to the script as argv"),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Max run time (default 60, max 300)"),
    },
    execute: (params, bridge) => bridge("run_skill", params),
    tag: "skills",
  },

  {
    name: "delete_skill",
    description: "Delete a saved skill and its script file permanently.",
    schema: {
      name: z.string().describe("Skill name to delete"),
    },
    execute: (params, bridge) => bridge("delete_skill", params),
    tag: "skills",
  },

  {
    name: "save_instruction_skill",
    description: `Save (or update) a reusable instruction skill — a markdown workflow bundle you can load later with read_instruction_skill.

Use instruction skills for reusable procedures that require judgement rather than subprocess execution: review protocols, debugging playbooks, backend investigation steps, release checklists, or house style instructions. They are not factual memory; store facts in memory/palace instead. Saving to an existing name replaces that instruction skill.`,
    schema: {
      name: z
        .string()
        .describe(
          "Unique instruction skill name, 1-64 chars of letters/digits/dash/underscore (becomes the markdown filename)",
        ),
      description: z
        .string()
        .describe(
          "One line: what workflow this covers and when to use it (shown in list_instruction_skills)",
        ),
      body: z
        .string()
        .describe("Full markdown instructions for the workflow (max 128KB)"),
    },
    execute: (params, bridge) => bridge("save_instruction_skill", params),
    tag: "skills",
  },

  {
    name: "list_instruction_skills",
    description:
      "List saved instruction skills with descriptions. Check here before re-deriving a reusable workflow or process.",
    schema: {},
    execute: (_params, bridge) => bridge("list_instruction_skills", {}),
    tag: "skills",
  },

  {
    name: "find_instruction_skills",
    description:
      "Search saved instruction skills by query and return ranked discovery results. Use this to select the relevant workflow before loading its full body with read_instruction_skill.",
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
    execute: (params, bridge) => bridge("find_instruction_skills", params),
    tag: "skills",
  },

  {
    name: "read_instruction_skill",
    description:
      "Read the full markdown body for a saved instruction skill. Load it before following that workflow; descriptions are only discovery hints.",
    schema: {
      name: z.string().describe("Instruction skill name"),
    },
    execute: (params, bridge) => bridge("read_instruction_skill", params),
    tag: "skills",
  },

  {
    name: "delete_instruction_skill",
    description:
      "Delete a saved instruction skill and its markdown file permanently.",
    schema: {
      name: z.string().describe("Instruction skill name to delete"),
    },
    execute: (params, bridge) => bridge("delete_instruction_skill", params),
    tag: "skills",
  },
];
