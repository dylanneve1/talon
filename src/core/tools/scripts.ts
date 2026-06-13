/**
 * Script tools — reusable agent-authored scripts.
 *
 * Scripts close the loop on procedures the agent works out during a
 * conversation: instead of re-deriving a multi-step pipeline (API
 * call chain, report generator, data transform) every time, the
 * agent saves it once and replays it with `run_script` — a local
 * subprocess, zero inference cost. Scripts are global (not chat-
 * scoped) and survive restarts.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const scriptTools: ToolDefinition[] = [
  {
    name: "save_script",
    description: `Save (or update) a reusable script — a named program you can run later with run_script.

Save a script whenever you've worked out a multi-step procedure worth repeating: fetching and formatting a report, transforming a file, calling an API chain. Next time, run_script replays it instantly as a local program instead of you re-deriving the steps. Scripts run with the workspace as cwd. Saving to an existing name replaces that script.

Make scripts parameterizable: extra arguments passed to run_script arrive as argv (bash: $1, $2…; python: sys.argv; node: process.argv).`,
    schema: {
      name: z
        .string()
        .describe(
          "Unique script name, 1-64 chars of letters/digits/dash/underscore (becomes the script filename)",
        ),
      description: z
        .string()
        .describe(
          "One line: what it does and when to use it (shown in list_scripts)",
        ),
      language: z.enum(["bash", "python", "node"]).describe("Script language"),
      script: z.string().describe("Full script body (max 64KB)"),
    },
    execute: (params, bridge) => bridge("save_script", params),
    tag: "scripts",
  },

  {
    name: "list_scripts",
    description:
      "List all saved scripts with language, usage stats, and descriptions. Check here before hand-writing a procedure you may have already saved.",
    schema: {},
    execute: (_params, bridge) => bridge("list_scripts", {}),
    tag: "scripts",
  },

  {
    name: "run_script",
    description:
      "Run a saved script to completion and get its output (stdout/stderr/exit code). Local execution — fast and free. Pass args to parameterize (they arrive as the script's argv).",
    schema: {
      name: z.string().describe("Script name (see list_scripts)"),
      args: z
        .array(z.string())
        .optional()
        .describe("Arguments passed to the script as argv"),
      timeout_seconds: z
        .number()
        .optional()
        .describe("Max run time (default 60, max 300)"),
    },
    execute: (params, bridge) => bridge("run_script", params),
    tag: "scripts",
  },

  {
    name: "delete_script",
    description: "Delete a saved script and its file permanently.",
    schema: {
      name: z.string().describe("Script name to delete"),
    },
    execute: (params, bridge) => bridge("delete_script", params),
    tag: "scripts",
  },
];
