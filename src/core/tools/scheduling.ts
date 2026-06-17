/**
 * Scheduling tools — cron CRUD and scheduled message cancellation.
 */

import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const schedulingTools: ToolDefinition[] = [
  {
    name: "cancel_scheduled",
    description: "Cancel a scheduled message.",
    schema: { schedule_id: z.string() },
    execute: (params, bridge) => bridge("cancel_scheduled", params),
    frontends: ["telegram", "discord"],
    tag: "scheduling",
  },

  {
    name: "create_cron_job",
    description: `Create a persistent recurring scheduled job. Jobs survive restarts.

Cron format: "minute hour day month weekday" (5 fields)
Examples:
  "0 9 * * *"     = every day at 9:00 AM
  "30 14 * * 1-5" = weekdays at 2:30 PM
  "*/15 * * * *"  = every 15 minutes
  "0 0 1 * *"     = first day of every month at midnight
  "0 8 * * 1"     = every Monday at 8:00 AM

Type "message" sends the content as a text message.
Type "query" runs the content as a Claude prompt with full tool access (can search, create files, send messages, etc).

Model: leave "model" unset to run on this chat's model (preferred). Only set it for a "query" job that should run on a cheaper model from the SAME backend as this chat — e.g. a routine daily task that doesn't need the flagship model. The job still resumes this chat's session (same backend = session continuity preserved). The model must be a valid, selectable model id on this chat's backend; an invalid or cross-backend id is rejected — pick from the available models.`,
    schema: {
      name: z.string().describe("Human-readable name for the job"),
      schedule: z
        .string()
        .describe("Cron expression (5-field: minute hour day month weekday)"),
      type: z
        .enum(["message", "query"])
        .describe(
          "Job type: 'message' sends text, 'query' runs a Claude prompt",
        ),
      content: z.string().describe("Message text or query prompt"),
      timezone: z
        .string()
        .optional()
        .describe(
          "IANA timezone (e.g. 'America/New_York'). Defaults to system timezone.",
        ),
      model: z
        .string()
        .optional()
        .describe(
          "Optional model override for 'query' jobs. Unset = this chat's model (preferred). Set only to run on a cheaper model from the SAME backend as this chat (session continuity is preserved). Must be a valid, selectable model id on this chat's backend — call list_models to see valid ids; an invalid or cross-backend id is rejected.",
        ),
    },
    execute: (params, bridge) => bridge("create_cron_job", params),
    tag: "scheduling",
  },

  {
    name: "list_cron_jobs",
    description:
      "List all cron jobs in the current chat with their status, schedule, run count, and next run time.",
    schema: {},
    execute: (_params, bridge) => bridge("list_cron_jobs", {}),
    tag: "scheduling",
  },

  {
    name: "edit_cron_job",
    description:
      "Edit an existing cron job. Only provide the fields you want to change.",
    schema: {
      job_id: z.string().describe("Job ID to edit"),
      name: z.string().optional().describe("New name"),
      schedule: z.string().optional().describe("New cron expression"),
      type: z.enum(["message", "query"]).optional().describe("New job type"),
      content: z.string().optional().describe("New content"),
      enabled: z.boolean().optional().describe("Enable or disable the job"),
      timezone: z.string().optional().describe("New IANA timezone"),
    },
    execute: (params, bridge) => bridge("edit_cron_job", params),
    tag: "scheduling",
  },

  {
    name: "delete_cron_job",
    description: "Delete a cron job permanently.",
    schema: {
      job_id: z.string().describe("Job ID to delete"),
    },
    execute: (params, bridge) => bridge("delete_cron_job", params),
    tag: "scheduling",
  },
];
