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
import {
  startHeartbeatTimer,
  stopHeartbeatTimer,
  awaitCurrentRun as awaitHeartbeat,
} from "./core/heartbeat.js";
import { startCronTimer, stopCronTimer } from "./core/cron.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { log, logError, logWarn } from "./util/log.js";
import { bootstrap, initBackendAndDispatcher } from "./bootstrap.js";
import { Gateway } from "./core/gateway.js";
import type { Frontend } from "./bootstrap.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

import { writeFileSync, unlinkSync } from "node:fs";
import { files as pathFiles } from "./util/paths.js";

const { config } = await bootstrap();

// Write PID file for daemon management
try {
  writeFileSync(pathFiles.pid, String(process.pid));
} catch {
  /* ok */
}

// ── Create gateway + frontend ─────────────────────────────────────────────────

const gateway = new Gateway();

const selectedFrontend = getFrontends(config)[0]; // use first configured frontend
let frontend: Frontend;

if (selectedFrontend === "terminal") {
  const { createTerminalFrontend } =
    await import("./frontend/terminal/index.js");
  frontend = createTerminalFrontend(config, gateway);
  log("bot", "Frontend: Terminal");
} else if (selectedFrontend === "teams") {
  const { createTeamsFrontend } = await import("./frontend/teams/index.js");
  frontend = createTeamsFrontend(config, gateway);
  log("bot", "Frontend: Teams");
} else {
  const { createTelegramFrontend } =
    await import("./frontend/telegram/index.js");
  frontend = createTelegramFrontend(config, gateway);
  log("bot", "Frontend: Telegram");
}

// ── Create backend + wire dispatcher ─────────────────────────────────────────

const { backend } = await initBackendAndDispatcher(config, frontend);
gateway.backend = backend;

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
  stopHeartbeatTimer();
  await awaitHeartbeat();
  stopCronTimer();
  stopWatchdog();
  stopUploadCleanup();
  flushSessions();
  flushChatSettings();
  flushCronJobs();
  flushHistory();
  flushMediaIndex();
  try {
    unlinkSync(pathFiles.pid);
  } catch {
    /* ok */
  }
  log("shutdown", "State saved");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  // EPIPE errors from network sockets (e.g. Telegram MTProto) are transient —
  // gramjs will reconnect; crashing the process here is wrong.
  if ((err as NodeJS.ErrnoException).code === "EPIPE") {
    logWarn("bot", `Suppressed transient EPIPE error: ${err.message}`);
    return;
  }
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
  if (config.heartbeat) startHeartbeatTimer(config.heartbeatIntervalMinutes);
  startCronTimer();
  startWatchdog(config.workspace);
  startUploadCleanup(config.workspace);

  await frontend.start();
}

main().catch((err) => {
  logError("bot", "Fatal startup error", err);
  process.exit(1);
});
