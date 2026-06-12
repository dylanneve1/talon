/**
 * Skill tools — save, list, run, and delete reusable agent-authored
 * scripts.
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
];
