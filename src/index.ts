/**
 * Talon — agentic AI harness.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * Frontends (Telegram, Terminal) and backends (Claude, OpenCode)
 * are loaded dynamically — only the selected platform's dependencies are required.
 */

import { getFrontends } from "./util/config.js";
import { startUploadCleanup, stopUploadCleanup } from "./util/workspace.js";
import { flushSessions } from "./storage/sessions.js";
import { flushChatSettings } from "./storage/chat-settings.js";
import { flushCronJobs } from "./storage/cron-store.js";
import { flushHistory } from "./storage/history.js";
import { flushMediaIndex } from "./storage/media-index.js";
import { getActiveCount } from "./core/dispatcher.js";
import { startPulseTimer, stopPulseTimer } from "./core/pulse.js";
import { startCronTimer, stopCronTimer } from "./core/cron.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { log, logError, logWarn } from "./util/log.js";
import { bootstrap, initBackendAndDispatcher } from "./bootstrap.js";
import type { Frontend } from "./bootstrap.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

const { config } = await bootstrap();

// ── Create frontend (dynamic import — only selected platform's deps required) ─

const selectedFrontend = getFrontends(config)[0]; // use first configured frontend
let frontend: Frontend;

if (selectedFrontend === "terminal") {
  const { createTerminalFrontend } = await import("./frontend/terminal/index.js");
  frontend = createTerminalFrontend(config);
  log("bot", "Frontend: Terminal");
} else {
  const { createTelegramFrontend } = await import("./frontend/telegram/index.js");
  frontend = createTelegramFrontend(config);
  log("bot", "Frontend: Telegram");
}

// ── Create backend + wire dispatcher ─────────────────────────────────────────

await initBackendAndDispatcher(config, frontend);

// ── Graceful shutdown ────────────────────────────────────────────────────────

let shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 15_000;

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log("shutdown", `${signal} received, shutting down gracefully...`);

  const forceTimer = setTimeout(() => {
    logError("shutdown", "Timeout exceeded, forcing exit");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  const pending = getActiveCount();
  if (pending > 0) {
    log("shutdown", `Waiting for ${pending} in-flight queries to drain...`);
    await new Promise((r) => setTimeout(r, 5000));
  }

  await frontend.stop();
  if (config.backend === "opencode") {
    const { stopOpenCodeServer } = await import("./backend/opencode/index.js");
    stopOpenCodeServer();
  }
  // Destroy plugins (cleanup resources)
  if (config.plugins.length > 0) {
    const { destroyPlugins } = await import("./core/plugin.js");
    await destroyPlugins();
  }
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
