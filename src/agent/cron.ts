/**
 * Cron scheduler — runs persistent recurring jobs.
 *
 * Every 60 seconds, checks all enabled cron jobs. If one is due, executes it.
 * Two job types: "message" sends text, "query" runs a Claude prompt with full tools.
 * Same init/start/stop pattern as pulse.ts.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { Cron } from "croner";
import type { TalonConfig } from "../util/config.js";
import { getSession, setSessionId } from "../storage/sessions.js";
import { getChatSettings } from "../storage/chat-settings.js";
import { getBridgePort, isBridgeBusy } from "../bridge/server.js";
import { sendText } from "../bridge/server.js";
import {
  getAllCronJobs,
  recordCronRun,
  type CronJob,
} from "../storage/cron-store.js";
import { appendDailyLog } from "../storage/daily-log.js";
import { log, logError } from "../util/log.js";
import { resolve } from "node:path";

// ── State ────────────────────────────────────────────────────────────────────

let config: TalonConfig | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

let bridgeSetContext: ((chatId: number, bot: unknown, inputFile: unknown) => void) | null = null;
let bridgeClearContext: ((chatId?: number | string) => void) | null = null;
let botInstance: unknown = null;
let inputFileClass: unknown = null;

const TICK_INTERVAL_MS = 60_000; // 60 seconds

// ── Public API ───────────────────────────────────────────────────────────────

export function initCron(params: {
  config: TalonConfig;
  setBridgeContext: (chatId: number, bot: unknown, inputFile: unknown) => void;
  clearBridgeContext: (chatId?: number | string) => void;
  bot: unknown;
  inputFile: unknown;
}): void {
  config = params.config;
  bridgeSetContext = params.setBridgeContext;
  bridgeClearContext = params.clearBridgeContext;
  botInstance = params.bot;
  inputFileClass = params.inputFile;
}

export function startCronTimer(): void {
  if (timer) return;
  log("cron", "Started: checking every 60s");
  timer = setInterval(() => {
    runCronTick().catch((err) => logError("cron", "Tick failed", err));
  }, TICK_INTERVAL_MS);
}

export function stopCronTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function runCronTick(): Promise<void> {
  if (!config || !bridgeSetContext || !bridgeClearContext || !botInstance) return;
  if (isBridgeBusy()) return;

  const now = new Date();
  const jobs = getAllCronJobs();

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (!isDue(job, now)) continue;

    // Check busy again before each job (a previous job may have locked the bridge)
    if (isBridgeBusy()) break;

    try {
      log("cron", `Executing "${job.name}" [${job.id}] (${job.type}) in chat ${job.chatId}`);
      await executeJob(job);
      recordCronRun(job.id);
      appendDailyLog("Cron", `Ran "${job.name}" (${job.type}) in chat ${job.chatId}`);
      log("cron", `Executed "${job.name}" [${job.id}] in chat ${job.chatId}`);
    } catch (err) {
      logError("cron", `Job "${job.name}" [${job.id}] failed`, err);
    }
  }
}

/**
 * Check if a job is due at the given time.
 * Uses croner's nextRun to find when the job should fire next relative to 1 minute ago,
 * and checks if that falls within the current minute. Ensures we don't double-fire.
 */
function isDue(job: CronJob, now: Date): boolean {
  try {
    // Check from 1 minute ago — if the next run from that reference falls in the current minute,
    // the job is due now
    const oneMinuteAgo = new Date(now.getTime() - 60_000);
    const cron = new Cron(job.schedule, { timezone: job.timezone ?? undefined });
    const next = cron.nextRun(oneMinuteAgo);
    if (!next) return false;

    const nowMinute = Math.floor(now.getTime() / 60_000);
    const nextMinute = Math.floor(next.getTime() / 60_000);
    if (nowMinute !== nextMinute) return false;

    // Don't run again if we already ran in this minute
    if (job.lastRunAt) {
      const lastMinute = Math.floor(job.lastRunAt / 60_000);
      if (lastMinute === nowMinute) return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function executeJob(job: CronJob): Promise<void> {
  if (!config || !bridgeSetContext || !bridgeClearContext || !botInstance) return;

  const numericChatId = parseInt(job.chatId, 10);
  if (isNaN(numericChatId)) return;

  if (job.type === "message") {
    // Simple message send — set bridge context, send, clear
    bridgeSetContext(numericChatId, botInstance, inputFileClass);
    try {
      await sendText(botInstance as never, numericChatId, job.content);
    } finally {
      bridgeClearContext(numericChatId);
    }
    return;
  }

  // type === "query" — run Claude with full tool access
  try {
    bridgeSetContext(numericChatId, botInstance, inputFileClass);

    const session = getSession(job.chatId);
    const chatSettings = getChatSettings(job.chatId);

    const options: Record<string, unknown> = {
      model: chatSettings.model ?? config.model,
      systemPrompt:
        config.systemPrompt +
        "\n\n## CRON JOB MODE\n" +
        `This is a scheduled cron job named "${job.name}" (schedule: ${job.schedule}).\n` +
        "Execute the task described in the prompt. You have full tool access.\n" +
        "Be concise and action-oriented.",
      cwd: config.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      betas: ["context-1m-2025-08-07"],
      thinking: { type: "adaptive" as const },
      effort: "low" as const,
      mcpServers: {
        "telegram-tools": {
          command: "node",
          args: ["--import", "tsx", resolve(import.meta.dirname ?? ".", "../bridge/tools.ts")],
          env: { TALON_BRIDGE_URL: `http://127.0.0.1:${getBridgePort() || 19876}` },
        },
      },
    };

    if (session.sessionId) options.resume = session.sessionId;

    const qi = query({
      prompt: job.content,
      options: options as never,
    });

    let newSessionId: string | undefined;
    for await (const message of qi) {
      const msg = message as Record<string, unknown>;
      if (msg.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
        newSessionId = msg.session_id;
      }
    }

    if (newSessionId) setSessionId(job.chatId, newSessionId);
  } catch (err) {
    logError("cron", `Query job "${job.name}" failed`, err);
  } finally {
    bridgeClearContext?.(numericChatId);
  }
}
