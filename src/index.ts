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
import { recordError, startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { log, logError, logWarn } from "./util/log.js";
import { classify } from "./core/errors.js";
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
} catch (err) {
  logWarn(
    "bot",
    `Failed to write PID file: ${err instanceof Error ? err.message : err}`,
  );
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

function flushAllState(): void {
  flushSessions();
  flushChatSettings();
  flushCronJobs();
  flushHistory();
  flushMediaIndex();
}

function removePidFile(): void {
  try {
    unlinkSync(pathFiles.pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function runShutdownStep(
  name: string,
  fn: () => void | Promise<void>,
): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (err) {
    logError("shutdown", `${name} failed`, err, { step: name });
    recordError(
      `Shutdown step ${name} failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

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

  const hasPlugins =
    config.plugins.length > 0 ||
    config.github?.enabled === true ||
    config.mempalace?.enabled === true ||
    config.playwright?.enabled === true;

  const shutdownSteps: Array<[string, () => void | Promise<void>]> = [
    ["frontend.stop", () => frontend.stop()],
    [
      "opencode.stop",
      async () => {
        if (config.backend !== "opencode") return;
        const { stopOpenCodeServer } =
          await import("./backend/opencode/index.js");
        stopOpenCodeServer();
      },
    ],
    [
      "plugins.destroy",
      async () => {
        if (!hasPlugins) return;
        const { destroyPlugins } = await import("./core/plugin.js");
        await destroyPlugins();
      },
    ],
    ["pulse.stop", () => stopPulseTimer()],
    [
      "heartbeat.stop",
      async () => {
        stopHeartbeatTimer();
        await awaitHeartbeat();
      },
    ],
    ["cron.stop", () => stopCronTimer()],
    ["watchdog.stop", () => stopWatchdog()],
    ["uploads.stop", () => stopUploadCleanup()],
    ["state.flush", () => flushAllState()],
    ["pid.remove", () => removePidFile()],
  ];

  let ok = true;
  for (const [name, fn] of shutdownSteps) {
    ok = (await runShutdownStep(name, fn)) && ok;
  }
  log("shutdown", ok ? "State saved" : "Shutdown completed with errors");
  process.exit(ok ? 0 : 1);
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
  const classified = classify(err);
  logError("bot", "Uncaught exception", classified, {
    reason: classified.reason,
  });
  recordError(
    `Uncaught exception (${classified.reason}): ${classified.message}`,
  );
  flushAllState();
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const classified = classify(reason);
  logError("bot", "Unhandled promise rejection", classified, {
    reason: classified.reason,
    retryable: classified.retryable,
  });
  recordError(
    `Unhandled rejection (${classified.reason}): ${classified.message}`,
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
  const classified = classify(err);
  logError("bot", "Fatal startup error", classified, {
    reason: classified.reason,
  });
  recordError(
    `Fatal startup error (${classified.reason}): ${classified.message}`,
  );
  process.exit(1);
});
