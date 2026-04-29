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
import {
  addTrigger,
  deleteTrigger,
  generateTriggerId,
  getActiveTriggersForChat,
  getTrigger,
  getTriggerByName,
  getTriggersForChat,
  readTriggerLogTail,
  triggerLogPath,
  validateLanguage,
  validateName,
  validateScript,
  validateTimeout,
  writeScriptFile,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_ACTIVE_PER_CHAT,
  type TriggerLanguage,
} from "../storage/trigger-store.js";
import { cancelTrigger, spawnTrigger } from "./triggers.js";
import { log, logWarn } from "../util/log.js";
import type { ActionResult, QueryBackend } from "./types.js";

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
  backend?: QueryBackend | null,
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

    // ── Triggers (long-running watcher scripts) ──────────────────────────

    case "trigger_create": {
      const name = String(body.name ?? "").trim();
      const language = body.language;
      const script = String(body.script ?? "");
      const timeoutSeconds =
        body.timeout_seconds != null
          ? Number(body.timeout_seconds)
          : DEFAULT_TIMEOUT_SECONDS;
      const description = body.description
        ? String(body.description)
        : undefined;

      const nameErr = validateName(name);
      if (nameErr) return { ok: false, error: nameErr };
      if (!validateLanguage(language))
        return {
          ok: false,
          error: `Unsupported language. Choose one of: bash, python, node`,
        };
      const scriptErr = validateScript(script);
      if (scriptErr) return { ok: false, error: scriptErr };
      const timeoutErr = validateTimeout(timeoutSeconds);
      if (timeoutErr) return { ok: false, error: timeoutErr };

      const chatIdStr = String(chatId);
      if (getTriggerByName(chatIdStr, name)) {
        return {
          ok: false,
          error: `A trigger named "${name}" already exists in this chat. Cancel it first or pick a different name.`,
        };
      }
      const active = getActiveTriggersForChat(chatIdStr);
      if (active.length >= MAX_ACTIVE_PER_CHAT) {
        return {
          ok: false,
          error: `Per-chat trigger cap reached (${MAX_ACTIVE_PER_CHAT} active). Cancel one before creating another.`,
        };
      }

      const numericChatId = Number(chatId);
      if (!Number.isFinite(numericChatId)) {
        return {
          ok: false,
          error: `Cannot derive numeric chatId from ${chatId}`,
        };
      }

      const id = generateTriggerId();
      const lang = language as TriggerLanguage;
      let scriptPath: string;
      try {
        scriptPath = writeScriptFile(chatIdStr, id, lang, script);
      } catch (err) {
        return {
          ok: false,
          error: `Failed to write script: ${err instanceof Error ? err.message : err}`,
        };
      }
      const logPath = triggerLogPath(chatIdStr, id);

      const trigger = {
        id,
        chatId: chatIdStr,
        numericChatId,
        name,
        language: lang,
        scriptPath,
        logPath,
        description,
        status: "pending" as const,
        createdAt: Date.now(),
        timeoutSeconds,
        fireCount: 0,
      };
      addTrigger(trigger);

      try {
        spawnTrigger(trigger);
      } catch (err) {
        return {
          ok: false,
          error: `Failed to spawn: ${err instanceof Error ? err.message : err}`,
        };
      }

      log("gateway", `trigger_create: "${name}" [${id}] (${lang})`);
      return {
        ok: true,
        text:
          `Created trigger "${name}" (id: ${id})\n` +
          `Language: ${lang}\n` +
          `Timeout: ${timeoutSeconds}s\n` +
          `Status: running`,
      };
    }

    case "trigger_list": {
      const triggers = getTriggersForChat(String(chatId));
      if (triggers.length === 0)
        return { ok: true, text: "No triggers in this chat." };
      const lines = triggers.map((t) => {
        const created = new Date(t.createdAt)
          .toISOString()
          .slice(0, 19)
          .replace("T", " ");
        const fireInfo =
          t.fireCount > 0
            ? `${t.fireCount} fire(s)${t.lastFireAt ? `, last ${new Date(t.lastFireAt).toISOString().slice(0, 19).replace("T", " ")}` : ""}`
            : "no fires yet";
        const detail = [
          `- ${t.name} [${t.status}]`,
          `  ID: ${t.id}`,
          `  Language: ${t.language}`,
          `  Created: ${created} (timeout ${t.timeoutSeconds}s)`,
          `  ${fireInfo}`,
        ];
        if (t.description) detail.push(`  Note: ${t.description}`);
        if (t.lastError) detail.push(`  Error: ${t.lastError}`);
        return detail.join("\n");
      });
      return {
        ok: true,
        text: `Triggers (${triggers.length}):\n\n${lines.join("\n\n")}`,
      };
    }

    case "trigger_cancel": {
      const triggerId = String(body.trigger_id ?? "");
      if (!triggerId) return { ok: false, error: "Missing trigger_id" };
      const t = getTrigger(triggerId);
      if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
      if (t.chatId !== String(chatId))
        return { ok: false, error: "Trigger belongs to a different chat" };
      const wasRunning = cancelTrigger(triggerId);
      if (!wasRunning) {
        return {
          ok: true,
          text: `Trigger "${t.name}" (${triggerId}) was already in status "${t.status}".`,
        };
      }
      return {
        ok: true,
        text: `Cancelled trigger "${t.name}" (${triggerId}). SIGTERM sent; SIGKILL after 5s grace.`,
      };
    }

    case "trigger_logs": {
      const triggerId = String(body.trigger_id ?? "");
      if (!triggerId) return { ok: false, error: "Missing trigger_id" };
      const t = getTrigger(triggerId);
      if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
      if (t.chatId !== String(chatId))
        return { ok: false, error: "Trigger belongs to a different chat" };
      const lines = Math.min(500, Math.max(1, Number(body.lines ?? 80)));
      const { tail, truncated } = readTriggerLogTail(t.logPath, lines);
      const preface =
        `Trigger "${t.name}" (${triggerId}) — status ${t.status}` +
        (truncated ? `, showing last ${lines} lines:` : `:`);
      return {
        ok: true,
        text: `${preface}\n\n${tail || "(empty)"}`,
      };
    }

    case "trigger_delete": {
      const triggerId = String(body.trigger_id ?? "");
      if (!triggerId) return { ok: false, error: "Missing trigger_id" };
      const t = getTrigger(triggerId);
      if (!t) return { ok: false, error: `Trigger ${triggerId} not found` };
      if (t.chatId !== String(chatId))
        return { ok: false, error: "Trigger belongs to a different chat" };
      // Cancel first if it's still running so we don't orphan a child
      cancelTrigger(triggerId);
      deleteTrigger(triggerId);
      return {
        ok: true,
        text: `Deleted trigger "${t.name}" (${triggerId}).`,
      };
    }

    // ── Plugin hot-reload ──────────────────────────────────────────────
    case "reload_plugins": {
      try {
        const { reloadPlugins, getPluginPromptAdditions } =
          await import("./plugin.js");
        const { rebuildSystemPrompt } = await import("../util/config.js");

        // reloadPlugins reads + validates config internally — no double read.
        // Frontends are derived from config if not explicitly provided.
        const { names, config: freshConfig } = await reloadPlugins();

        // Rebuild system prompt on the freshConfig, then update the backend's
        // live config reference so subsequent messages use the new prompt
        rebuildSystemPrompt(freshConfig, getPluginPromptAdditions());
        backend?.updateSystemPrompt?.(freshConfig.systemPrompt);

        // Hot-swap MCP servers on the active query so new plugin tools
        // are available immediately (not just on the next message)
        let mcpInfo = "";
        if (backend?.refreshMcpServers) {
          try {
            // Prefer body._chatId (string chat ID passed by frontends that use
            // non-numeric IDs, e.g. Teams/terminal) over the numeric context ID.
            const refreshChatId =
              typeof body._chatId === "string" && body._chatId.length > 0
                ? body._chatId
                : String(chatId);
            const result = await backend.refreshMcpServers(refreshChatId);
            if (result) {
              const parts: string[] = [];
              if (result.added.length > 0)
                parts.push(`added: ${result.added.join(", ")}`);
              if (result.removed.length > 0)
                parts.push(`removed: ${result.removed.join(", ")}`);
              const errorKeys = Object.keys(result.errors);
              if (errorKeys.length > 0)
                parts.push(
                  `errors: ${errorKeys.map((k) => `${k}: ${result.errors[k]}`).join("; ")}`,
                );
              if (parts.length > 0)
                mcpInfo = `\nMCP servers updated: ${parts.join(" | ")}`;
            }
          } catch (err) {
            logWarn(
              "gateway",
              `MCP server refresh failed during reload: ${err instanceof Error ? err.message : err}`,
            );
            mcpInfo = `\nWarning: MCP server refresh failed: ${err instanceof Error ? err.message : err}`;
          }
        }

        log("gateway", `reload_plugins: ${names.length} plugins loaded`);
        return {
          ok: true,
          text:
            `Plugins reloaded successfully.\n` +
            `Loaded (${names.length}): ${names.length > 0 ? names.join(", ") : "(none)"}` +
            mcpInfo,
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
