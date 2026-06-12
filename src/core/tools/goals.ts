/**
 * Goal tools — persistent multi-turn objectives the agent commits to
 * and pursues across sessions (chat turns, heartbeat runs).
 *
 * Goals differ from cron jobs and triggers: a cron job fires on a
 * schedule and a trigger fires on a condition, but a goal is an
 * outcome — "get the release out", "keep watching that PR" — that
 * the background heartbeat agent re-reads on every run and makes
 * incremental progress on until it's completed or abandoned.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";
import { chatIdSchema } from "./schemas.js";

/**
 * Heartbeat-mode routing: like `send`, every goal tool threads an
 * optional explicit `chat_id` through to the bridge so background
 * agents (no ambient chat) can operate on a chat's goals. In chat
 * mode the parameter is omitted and the ambient context routes.
 */
const goalChatId = chatIdSchema
  .optional()
  .describe(
    "Chat the goal belongs to. Omit in chat mode (current chat). Required from heartbeat/background mode where there is no ambient chat — use the chat ID shown in the goal listing.",
  );

export const goalTools: ToolDefinition[] = [
  {
    name: "add_goal",
    description: `Commit to a persistent goal — a multi-day objective tracked across sessions.

Goals survive restarts and are re-read by the background heartbeat agent on every run, which makes incremental progress on them and records what it did. Use a goal when the user asks you to pursue, watch, or finish something that outlives this conversation ("keep an eye on the release", "remind me to follow up with Alex until it's done", "get the docs migrated this week"). For purely time-based actions use create_cron_job instead; for condition-watching scripts use create_trigger.`,
    schema: {
      title: z.string().describe("Short imperative objective (max 200 chars)"),
      description: z
        .string()
        .optional()
        .describe(
          "Context the heartbeat agent needs to make progress: links, success criteria, constraints (max 2000 chars)",
        ),
      priority: z
        .enum(["low", "normal", "high"])
        .optional()
        .describe("Priority (default: normal)"),
      due: z
        .string()
        .optional()
        .describe("Optional soft deadline, ISO 8601 (e.g. 2026-06-20)"),
      chat_id: goalChatId,
    },
    execute: (params, bridge) => bridge("add_goal", params),
    tag: "goals",
  },

  {
    name: "list_goals",
    description:
      "List this chat's goals with status, priority, due date, and last recorded progress. Defaults to open goals (active + paused); pass include_closed to also see completed/abandoned ones.",
    schema: {
      include_closed: z
        .boolean()
        .optional()
        .describe("Also list completed and abandoned goals"),
      chat_id: goalChatId,
    },
    execute: (params, bridge) => bridge("list_goals", params),
    tag: "goals",
  },

  {
    name: "update_goal",
    description: `Update a goal: record progress, change status, or edit its fields. Only provide what changes.

Record a progress_note whenever you advance a goal — the next heartbeat run reads it to pick up where you left off. Set status="completed" when the objective is achieved, "paused" to stop pursuing it temporarily, "abandoned" to drop it.`,
    schema: {
      goal_id: z.string().describe("Goal ID to update"),
      progress_note: z
        .string()
        .optional()
        .describe(
          "What was just done / learned / blocked on (max 1000 chars). Stamped with the current time.",
        ),
      status: z
        .enum(["active", "paused", "completed", "abandoned"])
        .optional()
        .describe("New status"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      priority: z
        .enum(["low", "normal", "high"])
        .optional()
        .describe("New priority"),
      due: z
        .string()
        .optional()
        .describe(
          "New soft deadline, ISO 8601. Pass an empty string to clear.",
        ),
      chat_id: goalChatId,
    },
    execute: (params, bridge) => bridge("update_goal", params),
    tag: "goals",
  },

  {
    name: "delete_goal",
    description:
      "Delete a goal permanently. Prefer update_goal with status='completed' or 'abandoned' — deletion erases the record entirely.",
    schema: {
      goal_id: z.string().describe("Goal ID to delete"),
      chat_id: goalChatId,
    },
    execute: (params, bridge) => bridge("delete_goal", params),
    tag: "goals",
  },
];
