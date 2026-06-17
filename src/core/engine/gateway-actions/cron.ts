/**
 * Cron CRUD — create / list / edit / delete scheduled jobs for a chat.
 */

import {
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  updateCronJob,
  deleteCronJob,
  validateCronExpression,
  generateCronId,
  type CronJobType,
} from "../../../storage/cron-store.js";
import { log } from "../../../util/log.js";
import { validateJobModelOverride } from "./shared.js";
import type { SharedActionHandlers } from "./types.js";

export const cronHandlers: SharedActionHandlers = {
  create_cron_job: async (body, chatId) => {
    const name = String(body.name ?? "Unnamed job");
    const schedule = String(body.schedule ?? "");
    const jobType = (body.type as CronJobType) ?? "message";
    const content = String(body.content ?? "");
    const timezone = body.timezone ? String(body.timezone) : undefined;
    const model = body.model ? String(body.model) : undefined;

    if (!schedule) return { ok: false, error: "Missing schedule expression" };
    if (!content) return { ok: false, error: "Missing content" };
    if (content.length > 10_000)
      return { ok: false, error: "Content too long (max 10,000 chars)" };
    // A model override only makes sense for "query" jobs (a "message" job
    // just sends text — no model runs).
    if (model && jobType !== "query")
      return {
        ok: false,
        error: "A model override only applies to 'query' jobs.",
      };

    const validation = validateCronExpression(schedule, timezone);
    if (!validation.valid)
      return {
        ok: false,
        error: `Invalid cron expression: ${validation.error}`,
      };

    // Validate the model up front so a bad id is rejected here instead of
    // silently failing at fire time.
    if (model) {
      const modelErr = await validateJobModelOverride(chatId, model);
      if (modelErr) return { ok: false, error: modelErr };
    }

    const id = generateCronId();
    addCronJob({
      id,
      chatId: String(chatId),
      schedule,
      type: jobType,
      content,
      name,
      enabled: true,
      createdAt: Date.now(),
      runCount: 0,
      timezone,
      ...(model ? { model } : {}),
    });
    log("gateway", `create_cron_job: "${name}" [${schedule}]`);
    return {
      ok: true,
      text: `Created cron job "${name}" (id: ${id})\nSchedule: ${schedule}\nType: ${jobType}\nNext run: ${validation.next ?? "unknown"}`,
    };
  },

  list_cron_jobs: (body, chatId) => {
    const jobs = getCronJobsForChat(String(chatId));
    if (jobs.length === 0)
      return { ok: true, text: "No cron jobs in this chat." };
    const lines = jobs.map((j) => {
      const status = j.enabled ? "enabled" : "disabled";
      const lastRun = j.lastRunAt
        ? new Date(j.lastRunAt).toISOString().slice(0, 16).replace("T", " ")
        : "never";
      const v = validateCronExpression(j.schedule, j.timezone);
      const nextRun = v.next
        ? new Date(v.next).toISOString().slice(0, 16).replace("T", " ")
        : "unknown";
      return [
        `- ${j.name} (${status})`,
        `  ID: ${j.id}`,
        `  Schedule: ${j.schedule}${j.timezone ? ` (${j.timezone})` : ""}`,
        `  Type: ${j.type}`,
        `  Content: ${j.content.slice(0, 100)}${j.content.length > 100 ? "..." : ""}`,
        `  Runs: ${j.runCount} | Last: ${lastRun} | Next: ${nextRun}`,
      ].join("\n");
    });
    return {
      ok: true,
      text: `Cron jobs (${jobs.length}):\n\n${lines.join("\n\n")}`,
    };
  },

  edit_cron_job: (body, chatId) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== String(chatId))
      return { ok: false, error: "Job belongs to a different chat" };

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = String(body.name);
    if (body.content !== undefined) updates.content = String(body.content);
    if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
    if (body.type !== undefined) updates.type = String(body.type);
    if (body.timezone !== undefined)
      updates.timezone = body.timezone ? String(body.timezone) : undefined;
    if (body.schedule !== undefined) {
      const v = validateCronExpression(
        String(body.schedule),
        (updates.timezone as string | undefined) ?? job.timezone,
      );
      if (!v.valid)
        return { ok: false, error: `Invalid cron expression: ${v.error}` };
      updates.schedule = String(body.schedule);
    }

    const updated = updateCronJob(jobId, updates);
    return {
      ok: true,
      text: `Updated job "${updated?.name ?? jobId}". Fields changed: ${Object.keys(updates).join(", ")}`,
    };
  },

  delete_cron_job: (body, chatId) => {
    const jobId = String(body.job_id ?? "");
    if (!jobId) return { ok: false, error: "Missing job_id" };
    const job = getCronJob(jobId);
    if (!job) return { ok: false, error: `Job ${jobId} not found` };
    if (job.chatId !== String(chatId))
      return { ok: false, error: "Job belongs to a different chat" };
    deleteCronJob(jobId);
    return { ok: true, text: `Deleted cron job "${job.name}" (${jobId})` };
  },
};
