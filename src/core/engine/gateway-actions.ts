/**
 * Shared gateway actions — platform-agnostic handlers that work with any frontend.
 *
 * Handles: cron CRUD, fetch_url, plugin reload, in-memory history queries.
 * Returns null if the action isn't recognized (so the gateway delegates to the frontend).
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as cheerio from "cheerio";
import { dirs } from "../../util/paths.js";
import {
  getRecentFormatted,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
} from "../../storage/history.js";
import { formatMediaIndex } from "../../storage/media-index.js";
import {
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  updateCronJob,
  deleteCronJob,
  validateCronExpression,
  generateCronId,
  type CronJobType,
} from "../../storage/cron-store.js";
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
} from "../../storage/trigger-store.js";
import { cancelTrigger, spawnTrigger } from "../background/triggers.js";
import { resolveExplicitModelRef } from "../models/active-model.js";
import {
  getBackendForChat,
  getBackendIdForChat,
  getAvailableBackends,
  getPooledBackend,
  acquireBackendInstance,
} from "./backend-controller.js";
import {
  deleteScript,
  formatScript,
  getAllScripts,
  getScript,
  recordScriptUse,
  saveScript,
  validateScriptDescription,
  validateScriptLanguage,
  validateScriptName,
  validateScriptBody,
} from "../../storage/script-store.js";
import {
  deleteSkill,
  formatSkill,
  formatSkillSearchResult,
  listSkills,
  readSkill,
  saveSkill,
  searchSkills,
  validateSkillBody,
  validateSkillDescription,
  validateSkillName,
} from "../../storage/skill-store.js";
import {
  runScript,
  validateScriptTimeout,
  DEFAULT_SCRIPT_TIMEOUT_SECONDS,
} from "../scripts/runner.js";
import {
  addGoal,
  countOpenGoalsForChat,
  deleteGoal,
  formatGoal,
  generateGoalId,
  getGoal,
  getGoalsForChat,
  isGoalPriority,
  isGoalStatus,
  updateGoal,
  validateDescription,
  validateProgressNote,
  validateTitle,
  GOAL_STATUSES,
  MAX_OPEN_GOALS_PER_CHAT,
  OPEN_GOAL_STATUSES,
  type Goal,
  type GoalStatus,
} from "../../storage/goal-store.js";
import { log, logWarn } from "../../util/log.js";
import type { ActionResult } from "../types.js";
import type { Backend } from "../agent-runtime/capabilities.js";

/**
 * Parse a goal due date. Accepts ISO 8601 strings (date-only or full
 * timestamp). Returns unix ms, or undefined when unparseable.
 */
function parseDueDate(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Extract readable text from HTML using cheerio (proper DOM parser). */
function extractText(html: string, maxLength = 8000): string {
  const $ = cheerio.load(html);
  // Remove non-content elements
  $("script, style, noscript, iframe, svg, nav, footer, header").remove();
  // Get text content, normalize whitespace
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return text.slice(0, maxLength);
}

/**
 * Validate a per-job model override so create_cron_job / trigger_create can
 * reject a bad override up front — the agent retries or tells the user —
 * instead of storing one that fails at fire time.
 *
 * The override is restricted to the chat's own backend so the wake-up can
 * resume the existing session (a session id is backend-specific). The model
 * must therefore be selectable on the chat's backend; returns an error string
 * when it isn't, or `null` when it's valid.
 */
async function validateJobModelOverride(
  chatId: number,
  model: string,
): Promise<string | null> {
  try {
    const chatIdStr = String(chatId);
    const ref = await resolveExplicitModelRef(
      model,
      getBackendForChat(chatIdStr),
      getBackendIdForChat(chatIdStr),
    );
    if (!ref) {
      return (
        `Model "${model}" is not a selectable model on this chat's backend. ` +
        `Leave model unset to use the chat's model, or pick a valid model id ` +
        `on the same backend (cross-backend models aren't allowed — they'd ` +
        `break session continuity).`
      );
    }
    return null;
  } catch (err) {
    return `Could not validate model override: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function handleSharedAction(
  body: Record<string, unknown>,
  chatId: number,
  backend?: Backend | null,
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
      const persistent = body.persistent === true;
      const model = body.model ? String(body.model) : undefined;

      const nameErr = validateName(name);
      if (nameErr) return { ok: false, error: nameErr };
      if (!validateLanguage(language))
        return {
          ok: false,
          error: `Unsupported language. Choose one of: bash, python, node, lua`,
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

      // Validate the model up front so a bad id is rejected here instead of
      // silently failing at fire time.
      if (model) {
        const modelErr = await validateJobModelOverride(chatId, model);
        if (modelErr) return { ok: false, error: modelErr };
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
        persistent,
        ...(model ? { model } : {}),
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

      // spawnTrigger() can fail without throwing — e.g. an unsupported
      // language slips past the validateLanguage() check (defence in depth),
      // child.pid is undefined, or spawn() itself catches and routes through
      // failTrigger(). In all of those paths the trigger lands in `errored`
      // with `lastError` set. Re-read the store and surface the real status
      // so callers never get a false "running" response.
      const stored = getTrigger(id);
      if (!stored || stored.status === "errored") {
        return {
          ok: false,
          error: stored?.lastError ?? "Failed to spawn (unknown error)",
        };
      }

      log("gateway", `trigger_create: "${name}" [${id}] (${lang})`);
      return {
        ok: true,
        text:
          `Created trigger "${name}" (id: ${id})\n` +
          `Language: ${lang}\n` +
          `Timeout: ${timeoutSeconds}s\n` +
          `Persistent: ${persistent ? "yes (respawns on Talon restart)" : "no"}\n` +
          `Status: ${stored.status}`,
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
          `- ${t.name} [${t.status}]${t.persistent ? " (persistent)" : ""}`,
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

    // ── Goals (persistent multi-turn objectives) ─────────────────────────

    case "add_goal": {
      const title = String(body.title ?? "").trim();
      const description = body.description
        ? String(body.description)
        : undefined;
      const priority = body.priority ?? "normal";

      const titleErr = validateTitle(title);
      if (titleErr) return { ok: false, error: titleErr };
      const descErr = validateDescription(description);
      if (descErr) return { ok: false, error: descErr };
      if (!isGoalPriority(priority))
        return { ok: false, error: "Priority must be low, normal, or high" };

      let dueAt: number | undefined;
      if (body.due !== undefined && body.due !== "") {
        dueAt = parseDueDate(body.due);
        if (dueAt === undefined)
          return {
            ok: false,
            error: `Invalid due date "${body.due}" — use ISO 8601 (e.g. 2026-06-20)`,
          };
      }

      const chatIdStr = String(chatId);
      const openCount = countOpenGoalsForChat(chatIdStr);
      if (openCount >= MAX_OPEN_GOALS_PER_CHAT) {
        return {
          ok: false,
          error: `Per-chat open-goal cap reached (${MAX_OPEN_GOALS_PER_CHAT}). Complete or abandon one before adding another.`,
        };
      }

      const now = Date.now();
      const goal: Goal = {
        id: generateGoalId(),
        chatId: chatIdStr,
        title,
        description,
        status: "active",
        priority,
        createdAt: now,
        updatedAt: now,
        dueAt,
      };
      addGoal(goal);
      log("gateway", `add_goal: "${title}" [${goal.id}]`);
      return {
        ok: true,
        text:
          `Created goal "${title}" (id: ${goal.id})\n` +
          `Priority: ${priority}${dueAt ? `\nDue: ${new Date(dueAt).toISOString()}` : ""}\n` +
          `The background heartbeat agent will pursue this goal on its runs. Record progress with update_goal.`,
      };
    }

    case "list_goals": {
      const includeClosed = body.include_closed === true;
      const goals = getGoalsForChat(
        String(chatId),
        includeClosed ? GOAL_STATUSES : OPEN_GOAL_STATUSES,
      );
      if (goals.length === 0)
        return {
          ok: true,
          text: includeClosed
            ? "No goals in this chat."
            : "No open goals in this chat.",
        };
      return {
        ok: true,
        text: `Goals (${goals.length}):\n\n${goals.map((g) => formatGoal(g)).join("\n\n")}`,
      };
    }

    case "update_goal": {
      const goalId = String(body.goal_id ?? "");
      if (!goalId) return { ok: false, error: "Missing goal_id" };
      const goal = getGoal(goalId);
      if (!goal) return { ok: false, error: `Goal ${goalId} not found` };
      if (goal.chatId !== String(chatId))
        return { ok: false, error: "Goal belongs to a different chat" };

      const updates: Parameters<typeof updateGoal>[1] = {};
      if (body.progress_note !== undefined) {
        const note = String(body.progress_note);
        const noteErr = validateProgressNote(note);
        if (noteErr) return { ok: false, error: noteErr };
        updates.progressNote = note;
      }
      if (body.status !== undefined) {
        if (!isGoalStatus(body.status))
          return {
            ok: false,
            error: `Status must be one of: ${GOAL_STATUSES.join(", ")}`,
          };
        updates.status = body.status as GoalStatus;
      }
      if (body.title !== undefined) {
        const title = String(body.title).trim();
        const titleErr = validateTitle(title);
        if (titleErr) return { ok: false, error: titleErr };
        updates.title = title;
      }
      if (body.description !== undefined) {
        const description = String(body.description);
        const descErr = validateDescription(description);
        if (descErr) return { ok: false, error: descErr };
        updates.description = description;
      }
      if (body.priority !== undefined) {
        if (!isGoalPriority(body.priority))
          return { ok: false, error: "Priority must be low, normal, or high" };
        updates.priority = body.priority;
      }
      if (body.due !== undefined) {
        if (body.due === "") {
          updates.dueAt = null;
        } else {
          const dueAt = parseDueDate(body.due);
          if (dueAt === undefined)
            return {
              ok: false,
              error: `Invalid due date "${body.due}" — use ISO 8601 (e.g. 2026-06-20)`,
            };
          updates.dueAt = dueAt;
        }
      }
      if (Object.keys(updates).length === 0)
        return { ok: false, error: "No fields to update" };

      const updated = updateGoal(goalId, updates);
      log("gateway", `update_goal: "${updated?.title ?? goalId}" [${goalId}]`);
      return {
        ok: true,
        text: `Updated goal "${updated?.title ?? goalId}".\n\n${updated ? formatGoal(updated) : ""}`,
      };
    }

    case "delete_goal": {
      const goalId = String(body.goal_id ?? "");
      if (!goalId) return { ok: false, error: "Missing goal_id" };
      const goal = getGoal(goalId);
      if (!goal) return { ok: false, error: `Goal ${goalId} not found` };
      if (goal.chatId !== String(chatId))
        return { ok: false, error: "Goal belongs to a different chat" };
      deleteGoal(goalId);
      return { ok: true, text: `Deleted goal "${goal.title}" (${goalId})` };
    }

    // ── Scripts (reusable agent-authored scripts — global, not chat-scoped) ─

    case "save_script": {
      const name = String(body.name ?? "").trim();
      const description = String(body.description ?? "").trim();
      const language = body.language;
      const script = String(body.script ?? "");

      const nameErr = validateScriptName(name);
      if (nameErr) return { ok: false, error: nameErr };
      const descErr = validateScriptDescription(description);
      if (descErr) return { ok: false, error: descErr };
      if (!validateScriptLanguage(language))
        return {
          ok: false,
          error: "Unsupported language. Choose one of: bash, python, node",
        };
      const scriptErr = validateScriptBody(script);
      if (scriptErr) return { ok: false, error: scriptErr };

      const existed = Boolean(getScript(name));
      let saved;
      try {
        saved = saveScript({ name, description, language, script });
      } catch (err) {
        return {
          ok: false,
          error: `Failed to save script: ${err instanceof Error ? err.message : err}`,
        };
      }
      log("gateway", `save_script: "${name}" (${language})`);
      return {
        ok: true,
        text:
          `${existed ? "Updated" : "Saved"} script "${name}" (${language})\n` +
          `Script: ${saved.scriptPath}\n` +
          `Run it with run_script(name="${name}").`,
      };
    }

    case "list_scripts": {
      const scripts = getAllScripts();
      if (scripts.length === 0)
        return {
          ok: true,
          text: "No scripts saved yet. Use save_script to store a reusable procedure.",
        };
      return {
        ok: true,
        text: `Scripts (${scripts.length}):\n${scripts.map(formatScript).join("\n")}`,
      };
    }

    case "run_script": {
      const name = String(body.name ?? "").trim();
      if (!name) return { ok: false, error: "Missing name" };
      const script = getScript(name);
      if (!script)
        return {
          ok: false,
          error: `No script named "${name}". See list_scripts.`,
        };

      const args = Array.isArray(body.args) ? body.args.map(String) : [];
      const timeoutSeconds =
        body.timeout_seconds != null
          ? Number(body.timeout_seconds)
          : DEFAULT_SCRIPT_TIMEOUT_SECONDS;
      const timeoutErr = validateScriptTimeout(timeoutSeconds);
      if (timeoutErr) return { ok: false, error: timeoutErr };

      const result = await runScript(script, args, timeoutSeconds);
      // Usage stats only count completed (non-timeout, spawned) runs.
      if (!result.timedOut && result.exitCode !== null) {
        recordScriptUse(name);
      }

      const status = result.timedOut
        ? `TIMED OUT after ${timeoutSeconds}s`
        : `exit ${result.exitCode ?? "n/a"}`;
      const parts = [
        `Script "${name}" finished (${status}, ${result.durationMs}ms)`,
      ];
      if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trim()}`);
      if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trim()}`);
      if (!result.stdout.trim() && !result.stderr.trim())
        parts.push("(no output)");
      return {
        ok: !result.timedOut && result.exitCode === 0,
        ...(result.timedOut || result.exitCode !== 0
          ? { error: parts.join("\n\n") }
          : { text: parts.join("\n\n") }),
      };
    }

    case "delete_script": {
      const name = String(body.name ?? "").trim();
      if (!name) return { ok: false, error: "Missing name" };
      if (!deleteScript(name))
        return { ok: false, error: `No script named "${name}"` };
      return { ok: true, text: `Deleted script "${name}".` };
    }

    // ── Skills (markdown workflows — global, not chat-scoped) ─

    case "save_skill": {
      const name = String(body.name ?? "").trim();
      const description = String(body.description ?? "").trim();
      const skillBody = String(body.body ?? "");

      const nameErr = validateSkillName(name);
      if (nameErr) return { ok: false, error: nameErr };
      const descErr = validateSkillDescription(description);
      if (descErr) return { ok: false, error: descErr };
      const bodyErr = validateSkillBody(skillBody);
      if (bodyErr) return { ok: false, error: bodyErr };

      const existed = Boolean(readSkill(name));
      let skill;
      try {
        skill = saveSkill({ name, description, body: skillBody });
      } catch (err) {
        return {
          ok: false,
          error: `Failed to save skill: ${err instanceof Error ? err.message : err}`,
        };
      }
      log("gateway", `save_skill: "${name}"`);
      return {
        ok: true,
        text:
          `${existed ? "Updated" : "Saved"} skill "${name}"\n` +
          `SKILL.md: ${skill.path}\n` +
          `Bundle supporting files alongside it in that folder if needed.\n` +
          `Load it with read_skill(name="${name}").`,
      };
    }

    case "list_skills": {
      const skills = listSkills();
      if (skills.length === 0)
        return {
          ok: true,
          text: "No skills saved yet. Use save_skill to store a reusable markdown workflow.",
        };
      return {
        ok: true,
        text: `Skills (${skills.length}):\n${skills.map(formatSkill).join("\n")}`,
      };
    }

    case "find_skills": {
      const query = String(body.query ?? "").trim();
      if (!query) return { ok: false, error: "Missing query" };
      const limit = Math.min(50, Math.max(1, Number(body.limit ?? 10)));
      const results = searchSkills(query, limit);
      if (results.length === 0)
        return {
          ok: true,
          text: `No skills matched "${query}". Use list_skills to browse all saved workflows.`,
        };
      return {
        ok: true,
        text:
          `Skill matches for "${query}" (${results.length}):\n` +
          results.map(formatSkillSearchResult).join("\n"),
      };
    }

    case "read_skill": {
      const name = String(body.name ?? "").trim();
      if (!name) return { ok: false, error: "Missing name" };
      const skill = readSkill(name);
      if (!skill)
        return {
          ok: false,
          error: `No skill named "${name}". See list_skills.`,
        };
      const skillDirPath = dirname(skill.path);
      const lines = [
        `# ${skill.name}`,
        "",
        skill.description,
        "",
        `Path: ${skill.path}`,
      ];
      if (skill.resources.length > 0) {
        lines.push(
          `Bundled files (read with the Read tool from ${skillDirPath}): ${skill.resources.join(", ")}`,
        );
      }
      lines.push("", skill.body);
      return { ok: true, text: lines.join("\n") };
    }

    case "delete_skill": {
      const name = String(body.name ?? "").trim();
      if (!name) return { ok: false, error: "Missing name" };
      if (!deleteSkill(name))
        return { ok: false, error: `No skill named "${name}"` };
      return { ok: true, text: `Deleted skill "${name}".` };
    }

    // ── Plugin hot-reload ──────────────────────────────────────────────
    case "reload_plugins": {
      try {
        const { reloadPlugins, getPluginPromptAdditions } =
          await import("../plugin.js");
        const { rebuildSystemPrompt } = await import("../../util/config.js");
        const { clearSystemPromptSnapshots } =
          await import("../../backend/shared/system-prompt.js");

        // reloadPlugins reads + validates config internally — no double read.
        // Frontends are derived from config if not explicitly provided.
        const { names, config: freshConfig } = await reloadPlugins();

        // Rebuild system prompt on the freshConfig, then update the backend's
        // live config reference so subsequent messages use the new prompt
        rebuildSystemPrompt(freshConfig, getPluginPromptAdditions());
        backend?.control?.updateSystemPrompt?.(freshConfig.systemPrompt);

        // Plugin prompt additions changed — drop per-session prompt
        // snapshots so every chat's next turn picks up the new prompt
        // (deliberate one-time cache re-write per live session).
        clearSystemPromptSnapshots();

        // Hot-swap MCP servers on the active query so new plugin tools
        // are available immediately (not just on the next message)
        let mcpInfo = "";
        if (backend?.tools?.refreshTools) {
          try {
            // Prefer body._chatId (string chat ID passed by frontends that use
            // non-numeric IDs, e.g. Teams/terminal) over the numeric context ID.
            const refreshChatId =
              typeof body._chatId === "string" && body._chatId.length > 0
                ? body._chatId
                : String(chatId);
            const result = await backend.tools.refreshTools(refreshChatId);
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

    // ── Model / backend discovery ────────────────────────────────────────

    case "list_models": {
      const chatIdStr = String(chatId);
      const currentId = getBackendIdForChat(chatIdStr);
      const requested = body.backend ? String(body.backend).trim() : "";
      const targetId = requested || currentId;

      const avail = getAvailableBackends().map((b) => b.id);
      if (!avail.includes(targetId))
        return {
          ok: false,
          error: `Unknown backend "${targetId}". Available backends: ${avail.join(", ") || "(none)"}.`,
        };

      // Prefer a live instance (the chat's backend, or one already pooled).
      // For any other registered backend, boot it transiently to read its
      // catalog, then tear it back down so we never leak an instance.
      let instance =
        targetId === currentId
          ? getBackendForChat(chatIdStr)
          : getPooledBackend(targetId);
      let release: (() => Promise<void>) | null = null;
      if (!instance) {
        try {
          const acquired = await acquireBackendInstance(targetId);
          instance = acquired.backend;
          release = acquired.release;
        } catch (err) {
          return {
            ok: false,
            error: `Could not load backend "${targetId}" to read its models: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      try {
        const catalog = instance.models;
        if (!catalog?.listModels)
          return {
            ok: true,
            backend: targetId,
            models: [],
            text: `Backend "${targetId}" runs a fixed model (no selectable model catalog).`,
          };

        const { models } = await catalog.listModels("all");
        const selectable = models.filter((m) => m.selectable);
        const slim = selectable.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          reasoning: m.reasoning ?? false,
          contextWindow: m.contextWindow,
          free: m.free ?? false,
        }));
        if (slim.length === 0)
          return {
            ok: true,
            backend: targetId,
            models: [],
            text: `Backend "${targetId}" exposes no selectable models.`,
          };
        const note = targetId === currentId ? "" : " (not this chat's backend)";
        const lines = slim.map((m) => {
          const bits = [
            m.reasoning ? "reasoning" : null,
            m.contextWindow
              ? `${Math.round(m.contextWindow / 1000)}k ctx`
              : null,
            m.free ? "free" : null,
          ].filter(Boolean);
          const name =
            m.displayName && m.displayName !== m.id
              ? ` (${m.displayName})`
              : "";
          return `- ${m.id}${name}${bits.length ? ` — ${bits.join(", ")}` : ""}`;
        });
        return {
          ok: true,
          backend: targetId,
          models: slim,
          text: `Selectable models on "${targetId}"${note} (${slim.length}):\n${lines.join("\n")}`,
        };
      } finally {
        if (release) await release();
      }
    }

    case "list_backends": {
      const currentId = getBackendIdForChat(String(chatId));
      const backends = getAvailableBackends().map((b) => ({
        id: b.id,
        label: b.label,
        current: b.id === currentId,
      }));
      if (backends.length === 0)
        return { ok: true, backends: [], text: "No backends are available." };
      const lines = backends.map(
        (b) =>
          `- ${b.id}${b.label && b.label !== b.id ? ` (${b.label})` : ""}${b.current ? " — current" : ""}`,
      );
      return {
        ok: true,
        backends,
        text: `Available backends (${backends.length}):\n${lines.join("\n")}`,
      };
    }

    default:
      return null; // not a shared action — delegate to frontend
  }
}
