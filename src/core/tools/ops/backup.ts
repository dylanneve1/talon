/**
 * Backup tools — the agent's own access to its safety net.
 *
 * Three tools, and deliberately no fourth: there is no restore tool.
 * Restoring replaces the agent's memory, database and identity while it
 * is running, which is a decision for a human at a CLI or behind a
 * confirmation button, not something a model should be able to reach for
 * mid-turn. Taking a checkpoint, on the other hand, is cheap and always
 * safe — so the agent is encouraged to do it before it changes itself.
 */

import { z } from "zod";
import type { ToolDefinition } from "../types.js";

export const backupTools: ToolDefinition[] = [
  {
    name: "create_checkpoint",
    description: `Take a labelled snapshot of your whole state right now — config, prompts, keys, sessions, the database, your memory and skills, and the memory palace.

Reach for this BEFORE you change yourself in a way you might want undone: editing identity.md, a big memory rewrite, a risky config change, installing or reconfiguring a plugin. It takes seconds and costs no tokens.

Pin a checkpoint you want kept past the retention window (12 scheduled backups by default). Restoring is a human operation — 'talon backup restore <id>' or /backup restore <id> — so say the id in your reply if the checkpoint is the point of the turn.`,
    schema: {
      label: z
        .string()
        .min(1)
        .max(80)
        .describe(
          "Why this checkpoint exists, in a few words ('before identity rewrite'). Shown in every listing.",
        ),
      pin: z
        .boolean()
        .optional()
        .describe(
          "Keep it forever — pinned checkpoints are never pruned by retention. Default false.",
        ),
    },
    execute: (params, bridge) => bridge("create_checkpoint", params),
    tag: "backup",
  },

  {
    name: "list_checkpoints",
    description:
      "List recent snapshots — id, kind, label, size, whether pinned, and which remote targets hold a copy. Newest first. Use it to find the id of something you or the schedule took earlier.",
    schema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("How many to return (default 20, max 100)."),
    },
    execute: (params, bridge) => bridge("list_checkpoints", params),
    tag: "backup",
  },

  {
    name: "backup_status",
    description:
      "Health of the backup subsystem: when the last snapshot ran and when the next one is due, how many snapshots exist locally and how big they are, which remote targets are registered and whether they are ready, and whether recent runs have been failing.",
    schema: {},
    execute: (_params, bridge) => bridge("backup_status", {}),
    tag: "backup",
  },
];
