/**
 * Talon — Claude-powered Telegram bot.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * This file knows NOTHING about Telegram or Claude SDK specifics.
 * To swap frontends (Discord, CLI) or backends (OpenAI, Ollama),
 * change the imports below — no other file needs to change.
 */

import { loadConfig } from "./util/config.js";
import { initWorkspace } from "./util/workspace.js";
import { initAgent, handleMessage } from "./backend/claude-sdk/index.js";
import { loadSessions, flushSessions } from "./storage/sessions.js";
import { loadChatSettings } from "./storage/chat-settings.js";
import { loadCronJobs } from "./storage/cron-store.js";
import { initDispatcher } from "./core/dispatcher.js";
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
initWorkspace(config.workspace);
loadSessions();
loadChatSettings();
loadCronJobs();

// ── Create frontend (swap this line for a different platform) ────────────────

const frontend = createTelegramFrontend(config);

// ── Create backend (swap this line for a different AI provider) ──────────────

initAgent(config, frontend.getBridgePort);
const backend: QueryBackend = { query: (params) => handleMessage(params) };

// ── Wire dispatcher ─────────────────────────────────────────────────────────

initDispatcher({
  backend,
  context: frontend.context,
  sendTyping: frontend.sendTyping,
  onActivity: () => resetPulseTimer(),
});

// ── Initialize schedulers ───────────────────────────────────────────────────

initPulse();
initCron({ sendMessage: frontend.sendMessage });

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${signal} received, shutting down gracefully...`);
  await frontend.stop();
  stopPulseTimer();
  stopCronTimer();
  stopWatchdog();
  flushSessions();
  log("shutdown", "Sessions saved");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logError("bot", "Uncaught exception", err);
  flushSessions();
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

  if (process.env.TALON_PULSE !== "0") startPulseTimer();
  startCronTimer();
  startWatchdog();

  await frontend.start();
}

main().catch((err) => {
  logError("bot", "Fatal startup error", err);
  process.exit(1);
});
