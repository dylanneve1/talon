/**
 * Shared gateway actions — platform-agnostic handlers that work with any frontend.
 *
 * Handles: cron CRUD, fetch_url, in-memory history queries.
 * Returns null if the action isn't recognized (so the gateway delegates to the frontend).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getRecentFormatted,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
} from "../storage/history.js";
import { formatMediaIndex } from "../storage/media-index.js";
import {
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  updateCronJob,
  deleteCronJob,
  validateCronExpression,
  generateCronId,
  type CronJobType,
} from "../storage/cron-store.js";
import { log } from "../util/log.js";
import type { ActionResult } from "./types.js";

export async function handleSharedAction(
  body: Record<string, unknown>,
  chatId: number,
): Promise<ActionResult | null> {
  const action = body.action as string;

  switch (action) {
    // ── History (in-memory fallback) ──────────────────────────────────────
    // These are only used when userbot is not available.
    // Frontends can override these with richer implementations.

    case "read_history": {
      const limit = Math.min(100, Number(body.limit ?? 30));
      return { ok: true, text: getRecentFormatted(String(chatId), limit) };
    }

    case "search_history": {
      const limit = Math.min(100, Number(body.limit ?? 20));
      return { ok: true, text: searchHistory(String(chatId), String(body.query ?? ""), limit) };
    }

    case "get_user_messages": {
      const limit = Math.min(50, Number(body.limit ?? 20));
      return { ok: true, text: getMessagesByUser(String(chatId), String(body.user_name ?? ""), limit) };
    }

    case "list_known_users":
      return { ok: true, text: getKnownUsers(String(chatId)) };

    case "list_media":
      return { ok: true, text: formatMediaIndex(String(chatId), Math.min(20, Number(body.limit ?? 10))) };

    // ── Web fetch ────────────────────────────────────────────────────────

    case "fetch_url": {
      const url = String(body.url ?? "");
      if (!url) return { ok: false, error: "Missing URL" };
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: "URL must start with http:// or https://" };
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
          headers: { "User-Agent": "Talon/1.0" },
          redirect: "follow",
        });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const ct = resp.headers.get("content-type") ?? "";

        // Binary content: download and save to workspace
        const isText = ct.includes("text/") || ct.includes("application/json");
        if (!isText) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          if (buffer.length > 20 * 1024 * 1024) return { ok: false, error: "File too large (max 20MB)" };
          const ext = ct.includes("png") ? "png" : ct.includes("gif") ? "gif" : ct.includes("webp") ? "webp"
            : ct.includes("jpeg") || ct.includes("jpg") ? "jpg" : ct.includes("pdf") ? "pdf"
            : ct.includes("zip") ? "zip" : "bin";
          const uploadsDir = resolve(process.cwd(), "workspace", "uploads");
          if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
          const filePath = resolve(uploadsDir, `${Date.now()}-fetched.${ext}`);
          writeFileSync(filePath, buffer);
          const typeLabel = ct.startsWith("image/") ? "image" : ct.split("/")[1]?.split(";")[0] ?? "file";
          return { ok: true, text: `Downloaded ${typeLabel} (${(buffer.length / 1024).toFixed(0)}KB) to: ${filePath}\nRead it with the Read tool or send it with send(type="file", file_path="${filePath}").` };
        }
        const raw = await resp.text();
        const text = raw
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();
        if (text.length < 20) return { ok: true, text: "(Page has no readable content)" };
        return { ok: true, text: text.slice(0, 8000) };
      } catch (err) {
        return { ok: false, error: `Fetch failed: ${err instanceof Error ? err.message : err}` };
      }
    }

    // ── Cron CRUD ────────────────────────────────────────────────────────

    case "create_cron_job": {
      const name = String(body.name ?? "Unnamed job");
      const schedule = String(body.schedule ?? "");
      const jobType = (body.type as CronJobType) ?? "message";
      const content = String(body.content ?? "");
      const timezone = body.timezone ? String(body.timezone) : undefined;

      if (!schedule) return { ok: false, error: "Missing schedule expression" };
      if (!content) return { ok: false, error: "Missing content" };
      if (content.length > 10_000) return { ok: false, error: "Content too long (max 10,000 chars)" };

      const validation = validateCronExpression(schedule, timezone);
      if (!validation.valid) return { ok: false, error: `Invalid cron expression: ${validation.error}` };

      const id = generateCronId();
      addCronJob({ id, chatId: String(chatId), schedule, type: jobType, content, name, enabled: true, createdAt: Date.now(), runCount: 0, timezone });
      log("gateway", `create_cron_job: "${name}" [${schedule}]`);
      return { ok: true, text: `Created cron job "${name}" (id: ${id})\nSchedule: ${schedule}\nType: ${jobType}\nNext run: ${validation.next ?? "unknown"}` };
    }

    case "list_cron_jobs": {
      const jobs = getCronJobsForChat(String(chatId));
      if (jobs.length === 0) return { ok: true, text: "No cron jobs in this chat." };
      const lines = jobs.map((j) => {
        const status = j.enabled ? "enabled" : "disabled";
        const lastRun = j.lastRunAt ? new Date(j.lastRunAt).toISOString().slice(0, 16).replace("T", " ") : "never";
        const v = validateCronExpression(j.schedule, j.timezone);
        const nextRun = v.next ? new Date(v.next).toISOString().slice(0, 16).replace("T", " ") : "unknown";
        return [
          `- ${j.name} (${status})`, `  ID: ${j.id}`,
          `  Schedule: ${j.schedule}${j.timezone ? ` (${j.timezone})` : ""}`,
          `  Type: ${j.type}`, `  Content: ${j.content.slice(0, 100)}${j.content.length > 100 ? "..." : ""}`,
          `  Runs: ${j.runCount} | Last: ${lastRun} | Next: ${nextRun}`,
        ].join("\n");
      });
      return { ok: true, text: `Cron jobs (${jobs.length}):\n\n${lines.join("\n\n")}` };
    }

    case "edit_cron_job": {
      const jobId = String(body.job_id ?? "");
      if (!jobId) return { ok: false, error: "Missing job_id" };
      const job = getCronJob(jobId);
      if (!job) return { ok: false, error: `Job ${jobId} not found` };
      if (job.chatId !== String(chatId)) return { ok: false, error: "Job belongs to a different chat" };

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = String(body.name);
      if (body.content !== undefined) updates.content = String(body.content);
      if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
      if (body.type !== undefined) updates.type = String(body.type);
      if (body.timezone !== undefined) updates.timezone = body.timezone ? String(body.timezone) : undefined;
      if (body.schedule !== undefined) {
        const v = validateCronExpression(String(body.schedule), (updates.timezone as string | undefined) ?? job.timezone);
        if (!v.valid) return { ok: false, error: `Invalid cron expression: ${v.error}` };
        updates.schedule = String(body.schedule);
      }

      const updated = updateCronJob(jobId, updates);
      return { ok: true, text: `Updated job "${updated?.name ?? jobId}". Fields changed: ${Object.keys(updates).join(", ")}` };
    }

    case "delete_cron_job": {
      const jobId = String(body.job_id ?? "");
      if (!jobId) return { ok: false, error: "Missing job_id" };
      const job = getCronJob(jobId);
      if (!job) return { ok: false, error: `Job ${jobId} not found` };
      if (job.chatId !== String(chatId)) return { ok: false, error: "Job belongs to a different chat" };
      deleteCronJob(jobId);
      return { ok: true, text: `Deleted cron job "${job.name}" (${jobId})` };
    }

    default:
      return null; // not a shared action — delegate to frontend
  }
}
