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
Type "query" runs the content as a Claude prompt with full tool access, as an ISOLATED one-shot — its own session, no chat history. So a "query" cron job never touches the chat session, and may run on a cheaper model or a different provider. Leave "model"/"provider" unset to use this chat's model.`,
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
          "Optional model override for 'query' jobs. Unset = this chat's model. Since cron runs isolated, this may be a cheaper model — on this chat's backend, or (with 'provider') a different one. Call list_models to see valid ids.",
        ),
      provider: z
        .string()
        .optional()
        .describe(
          "Optional backend/provider id for the 'query' override (e.g. a cheaper provider). Requires 'model'. Unset = this chat's backend. Call list_backends to see ids.",
        ),
      instructions: z
        .string()
        .optional()
        .describe(
          "Optional short brief for the isolated run — what the job is and how to do it. Becomes the run's system prompt; recommended when using a cheaper override model.",
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
