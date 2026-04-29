/**
 * Trigger tools — bot-authored watcher scripts that wake the bot on demand.
 *
 * Triggers are long-running supervised subprocesses written by the model
 * itself. They poll, watch, or wait for arbitrary conditions and signal
 * back via a stdout protocol or by exiting. Each fire wakes the bot with
 * a system message containing the trigger's payload, so it can decide
 * whether to message the user, take an action, or do nothing.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

const TRIGGER_DESCRIPTION = `Create a long-running watcher script. The script runs as a supervised
subprocess and signals back via stdout or its exit code.

Stdout protocol:
  - A line starting with "TALON_FIRE: <text>" fires a wake-up immediately
    (the script keeps running). Use this for watchers that emit multiple
    events.
  - Exiting 0 fires a final wake-up with the tail of stdout/stderr as the
    payload.
  - Exiting non-zero fires an error wake-up with the exit code and log tail.
  - Hard timeout (default 24h, max 7d) kills the script and fires a
    "timed_out" wake-up.

Languages: "bash", "python", "node".

Examples:
  bash, name="pr-merge-watch":
    while [ "$(gh pr view 35337 --json state -q .state)" != "MERGED" ]; do
      sleep 60
    done
    echo "PR #35337 merged"

  python, name="poly-iran-swing" (mid-run multi-fire):
    import time, json, subprocess
    start = float(get_price())
    while True:
      px = float(get_price())
      if abs(px - start) / start > 0.05:
        print(f"TALON_FIRE: price moved to {px}", flush=True)
        start = px
      time.sleep(120)

The script is killed if Talon shuts down. Per-chat cap of 5 active triggers.`;

export const triggerTools: ToolDefinition[] = [
  {
    name: "trigger_create",
    description: TRIGGER_DESCRIPTION,
    schema: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Short identifier, unique per chat (letters, digits, space, dot, dash, underscore)",
        ),
      language: z
        .enum(["bash", "python", "node"])
        .describe("Interpreter to run the script under"),
      script: z
        .string()
        .min(1)
        .describe(
          "The full script body. Stdout is monitored for TALON_FIRE: lines.",
        ),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Hard kill timeout in seconds. Default 86400 (24h), max 604800 (7d).",
        ),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("Human-readable note about what the trigger watches for"),
    },
    execute: (params, bridge) => bridge("trigger_create", params),
    tag: "triggers",
  },

  {
    name: "trigger_list",
    description:
      "List all triggers in the current chat with their status, runtime, and fire count.",
    schema: {},
    execute: (_params, bridge) => bridge("trigger_list", {}),
    tag: "triggers",
  },

  {
    name: "trigger_cancel",
    description:
      "Cancel a running trigger (sends SIGTERM, then SIGKILL after 5s grace).",
    schema: {
      trigger_id: z.string().describe("Trigger ID to cancel"),
    },
    execute: (params, bridge) => bridge("trigger_cancel", params),
    tag: "triggers",
  },

  {
    name: "trigger_logs",
    description:
      "Read the tail of a trigger's run log (interleaved stdout + stderr, exit markers).",
    schema: {
      trigger_id: z.string().describe("Trigger ID to read logs for"),
      lines: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Number of trailing lines to return (default 80, max 500)"),
    },
    execute: (params, bridge) => bridge("trigger_logs", params),
    tag: "triggers",
  },

  {
    name: "trigger_delete",
    description:
      "Delete a trigger. Cancels it first if running, then removes its script and log from disk.",
    schema: {
      trigger_id: z.string().describe("Trigger ID to delete"),
    },
    execute: (params, bridge) => bridge("trigger_delete", params),
    tag: "triggers",
  },
];
