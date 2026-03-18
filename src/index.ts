/**
 * Talon — Claude-powered Telegram bot.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * This file knows NOTHING about Telegram or Claude SDK specifics.
 * To swap frontends (Discord, CLI) or backends (OpenAI, Ollama),
 * change the imports below — no other file needs to change.
 */

import { loadConfig } from "./util/config.js";
import { initWorkspace, startUploadCleanup, stopUploadCleanup } from "./util/workspace.js";
import { initAgent as initClaudeAgent, handleMessage as claudeHandleMessage } from "./backend/claude-sdk/index.js";
import { initOpenCodeAgent, handleMessage as opencodeHandleMessage, stopOpenCodeServer } from "./backend/opencode/index.js";
import { loadSessions, flushSessions } from "./storage/sessions.js";
import { loadChatSettings, flushChatSettings } from "./storage/chat-settings.js";
import { loadCronJobs, flushCronJobs } from "./storage/cron-store.js";
import { loadHistory, flushHistory } from "./storage/history.js";
import { loadMediaIndex, flushMediaIndex } from "./storage/media-index.js";
import { cleanupOldLogs } from "./storage/daily-log.js";
import { initDispatcher, getQueueSize } from "./core/dispatcher.js";
import {
  initPulse,
  startPulseTimer,
  stopPulseTimer,
  resetPulseTimer,
} from "./core/pulse.js";
import {
  initCron,
  startCronTimer,
  stopCronTimer,
} from "./core/cron.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { createTelegramFrontend } from "./frontend/telegram/index.js";
import { log, logError, logWarn } from "./util/log.js";
import type { QueryBackend } from "./core/types.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const config = loadConfig();

// Expose search config as env vars for gateway-actions
if (config.braveApiKey) process.env.TALON_BRAVE_API_KEY = config.braveApiKey;
if (config.searxngUrl) process.env.TALON_SEARXNG_URL = config.searxngUrl;

initWorkspace(config.workspace);
loadSessions();
loadChatSettings();
loadCronJobs();
loadHistory();
loadMediaIndex();
cleanupOldLogs();

// ── Create frontend (swap this line for a different platform) ────────────────

const frontend = createTelegramFrontend(config);

// ── Create backend ──────────────────────────────────────────────────────────

let backend: QueryBackend;
if (config.backend === "opencode") {
  initOpenCodeAgent(config, frontend.getBridgePort);
  backend = { query: (params) => opencodeHandleMessage(params) };
  log("bot", "Backend: OpenCode");
} else {
  initClaudeAgent(config, frontend.getBridgePort);
  backend = { query: (params) => claudeHandleMessage(params) };
  log("bot", "Backend: Claude SDK");
}

// ── Wire dispatcher ─────────────────────────────────────────────────────────

initDispatcher({
  backend,
  context: frontend.context,
  sendTyping: frontend.sendTyping,
  onActivity: () => resetPulseTimer(),
  concurrency: config.concurrency,
});

// ── Initialize schedulers ───────────────────────────────────────────────────

initPulse();
initCron({ sendMessage: frontend.sendMessage });

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${signal} received, shutting down gracefully...`);

  // Force exit if shutdown takes too long
  const forceTimer = setTimeout(() => {
    logError("shutdown", "Timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref(); // don't keep process alive

  // Wait for in-flight queries to drain
  const pending = getQueueSize();
  if (pending > 0) {
    log("shutdown", `Waiting for ${pending} in-flight queries to drain...`);
    // Give queries a few seconds to finish, then proceed
    await new Promise((r) => setTimeout(r, 5000));
  }

  await frontend.stop();
  if (config.backend === "opencode") stopOpenCodeServer();
  stopPulseTimer();
  stopCronTimer();
  stopWatchdog();
  stopUploadCleanup();
  flushSessions();
  flushChatSettings();
  flushCronJobs();
  flushHistory();
  flushMediaIndex();
  log("shutdown", "State saved");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logError("bot", "Uncaught exception", err);
  flushSessions();
  flushChatSettings();
  flushCronJobs();
  flushHistory();
  flushMediaIndex();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logWarn(
    "bot",
    `Unhandled rejection: ${reason instanceof Error ? reason.message : reason}`,
  );
});

// ── Start ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await frontend.init();
  log("bot", "Starting Talon...");

  if (config.pulse) startPulseTimer(config.pulseIntervalMs);
  startCronTimer();
  startWatchdog(config.workspace);
  startUploadCleanup(config.workspace);

  await frontend.start();
}

main().catch((err) => {
  logError("bot", "Fatal startup error", err);
  process.exit(1);
});
