/**
 * Shared gateway actions — platform-agnostic handlers that work with any frontend.
 *
 * Handles: cron CRUD, fetch_url, plugin reload, in-memory history queries.
 * Returns null if the action isn't recognized (so the gateway delegates to the frontend).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as cheerio from "cheerio";
import { dirs } from "../util/paths.js";
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

/** Extract readable text from HTML using cheerio (proper DOM parser). */
function extractText(html: string, maxLength = 8000): string {
  const $ = cheerio.load(html);
  // Remove non-content elements
  $("script, style, noscript, iframe, svg, nav, footer, header").remove();
  // Get text content, normalize whitespace
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.slice(0, maxLength);
}

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
      return {
        ok: true,
        text: searchHistory(String(chatId), String(body.query ?? ""), limit),
      };
    }

    case "get_user_messages": {
      const limit = Math.min(50, Number(body.limit ?? 20));
      return {
        ok: true,
        text: getMessagesByUser(
          String(chatId),
          String(body.user_name ?? ""),
          limit,
        ),
      };
    }

    case "list_known_users":
      return { ok: true, text: getKnownUsers(String(chatId)) };

    case "list_media":
      return {
        ok: true,
        text: formatMediaIndex(
          String(chatId),
          Math.min(20, Number(body.limit ?? 10)),
        ),
      };

    // ── Web fetch ────────────────────────────────────────────────────────

    case "fetch_url": {
      const url = String(body.url ?? "");
      if (!url) return { ok: false, error: "Missing URL" };
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return { ok: false, error: "URL must use http or https protocol" };
        }
      } catch {
        return { ok: false, error: "Invalid URL" };
      }
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(15_000),
          headers: { "User-Agent": "Talon/1.0" },
          redirect: "follow",
        });
        if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
        const ct = resp.headers.get("content-type") ?? "";

        // Reject oversized responses before downloading the body.
        // The Content-Length header is advisory but saves bandwidth when present.
        const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
        const contentLength = resp.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_BYTES) {
          return {
            ok: false,
            error: `File too large (${(Number(contentLength) / 1024 / 1024).toFixed(0)}MB, max 20MB)`,
          };
        }

        // Binary content: download and save to workspace
        const mimeType = ct.split(";")[0].trim().toLowerCase();
        const isText =
          mimeType.startsWith("text/") || mimeType === "application/json";
        if (!isText) {
          const buffer = Buffer.from(await resp.arrayBuffer());
          if (buffer.length > MAX_BYTES)
            return { ok: false, error: "File too large (max 20MB)" };
          if (buffer.length === 0)
            return { ok: false, error: "Empty response (0 bytes)" };

          // Validate magic bytes — prevent saving HTML error pages as images
          // (servers can return error pages with image content-type headers)
          const magic = buffer.subarray(0, 16);
          const isRealImage =
            (magic[0] === 0xff && magic[1] === 0xd8) || // JPEG
            (magic[0] === 0x89 &&
              magic[1] === 0x50 &&
              magic[2] === 0x4e &&
              magic[3] === 0x47) || // PNG
            (magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46) || // GIF
            (magic[0] === 0x52 &&
              magic[1] === 0x49 &&
              magic[2] === 0x46 &&
              magic[3] === 0x46 &&
              magic[8] === 0x57 &&
              magic[9] === 0x45 &&
              magic[10] === 0x42 &&
              magic[11] === 0x50); // WebP

          // If content-type says image but bytes say otherwise, treat as text
          if (ct.startsWith("image/") && !isRealImage) {
            const text = extractText(buffer.toString("utf-8"), 500);
            return {
              ok: false,
              error: `Server returned an error page instead of an image. Content: ${text}`,
            };
          }

          const ext = isRealImage
            ? magic[0] === 0xff
              ? "jpg"
              : magic[0] === 0x89
                ? "png"
                : magic[0] === 0x47
                  ? "gif"
                  : "webp"
            : ct.includes("pdf")
              ? "pdf"
              : ct.includes("zip")
                ? "zip"
                : "bin";
          const uploadsDir = dirs.uploads;
          if (!existsSync(uploadsDir))
            mkdirSync(uploadsDir, { recursive: true });
          const filePath = resolve(uploadsDir, `${Date.now()}-fetched.${ext}`);
          writeFileSync(filePath, buffer);
          const typeLabel = isRealImage
            ? "image"
            : (ct.split("/")[1]?.split(";")[0] ?? "file");
          return {
            ok: true,
            text: `Downloaded ${typeLabel} (${(buffer.length / 1024).toFixed(0)}KB) to: ${filePath}\nRead it with the Read tool or send it with send(type="file", file_path="${filePath}").`,
          };
        }
        const raw = await resp.text();
        const text = extractText(raw);
        if (text.length < 20)
          return { ok: true, text: "(Page has no readable content)" };
        return { ok: true, text };
      } catch (err) {
        return {
          ok: false,
          error: `Fetch failed: ${err instanceof Error ? err.message : err}`,
        };
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
      if (content.length > 10_000)
        return { ok: false, error: "Content too long (max 10,000 chars)" };

      const validation = validateCronExpression(schedule, timezone);
      if (!validation.valid)
        return {
          ok: false,
          error: `Invalid cron expression: ${validation.error}`,
        };

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
      });
      log("gateway", `create_cron_job: "${name}" [${schedule}]`);
      return {
        ok: true,
        text: `Created cron job "${name}" (id: ${id})\nSchedule: ${schedule}\nType: ${jobType}\nNext run: ${validation.next ?? "unknown"}`,
      };
    }

    case "list_cron_jobs": {
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
    }

    case "edit_cron_job": {
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
    }

    case "delete_cron_job": {
      const jobId = String(body.job_id ?? "");
      if (!jobId) return { ok: false, error: "Missing job_id" };
      const job = getCronJob(jobId);
      if (!job) return { ok: false, error: `Job ${jobId} not found` };
      if (job.chatId !== String(chatId))
        return { ok: false, error: "Job belongs to a different chat" };
      deleteCronJob(jobId);
      return { ok: true, text: `Deleted cron job "${job.name}" (${jobId})` };
    }

    // ── Plugin hot-reload ──────────────────────────────────────────────
    case "reload_plugins": {
      try {
        const { reloadPlugins, getPluginPromptAdditions } =
          await import("./plugin.js");
        const { loadConfig, rebuildSystemPrompt, getFrontends } =
          await import("../util/config.js");
        const { getAllSessions, resetSession } =
          await import("../storage/sessions.js");

        // Re-read config and reload all plugins
        const freshConfig = loadConfig();
        const frontends = getFrontends(freshConfig);
        const loaded = await reloadPlugins(frontends);

        // Rebuild system prompt with new plugin contributions
        rebuildSystemPrompt(freshConfig, getPluginPromptAdditions());

        // Reset all active sessions so the next query spawns fresh MCP
        // server subprocesses with the updated plugin config
        const sessions = getAllSessions();
        for (const { chatId: sid } of sessions) {
          resetSession(sid);
        }

        log(
          "gateway",
          `reload_plugins: ${loaded.length} plugins, ${sessions.length} sessions reset`,
        );
        return {
          ok: true,
          text:
            `Plugins reloaded successfully.\n` +
            `Loaded (${loaded.length}): ${loaded.length > 0 ? loaded.join(", ") : "(none)"}\n` +
            `Sessions reset: ${sessions.length}\n` +
            `Note: New MCP servers will spawn on the next message.`,
        };
      } catch (err) {
        return {
          ok: false,
          error: `Plugin reload failed: ${err instanceof Error ? err.message : err}`,
        };
      }
    }

    default:
      return null; // not a shared action — delegate to frontend
  }
}
