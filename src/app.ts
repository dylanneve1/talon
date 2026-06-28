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
import { flushTriggers } from "./storage/trigger-store.js";
import { flushHistory } from "./storage/history.js";
import { flushMediaIndex } from "./storage/media-index.js";
import { getActiveCount } from "./core/engine/dispatcher.js";
import { startPulseTimer, stopPulseTimer } from "./core/background/pulse.js";
import {
  startHeartbeatTimer,
  stopHeartbeatTimer,
  awaitCurrentRun as awaitHeartbeat,
} from "./core/background/heartbeat/index.js";
import {
  startCronTimer,
  stopCronTimer,
  runStartupCatchup,
} from "./core/background/cron.js";
import { shutdownTriggers } from "./core/background/triggers/index.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { log, logError, logWarn } from "./util/log.js";
import { bootstrap, initBackendAndDispatcher } from "./bootstrap.js";
import { Gateway } from "./core/engine/gateway.js";
import type { Frontend } from "./bootstrap.js";

// ── Bootstrap ────────────────────────────────────────────────────────────────

import {
  writePidRecord,
  removePidRecordIfOwnedBy,
} from "./core/daemon/pidfile.js";

const { config } = await bootstrap();

// Record this process as the daemon. The gateway port is appended once
// the gateway binds (it may fall back from the default on EADDRINUSE).
const bootedAt = new Date().toISOString();
writePidRecord({ pid: process.pid, startedAt: bootedAt });

// ── Create gateway + frontend ─────────────────────────────────────────────────

const gateway = new Gateway("daemon");
gateway.onStarted((port) =>
  writePidRecord({ pid: process.pid, port, startedAt: bootedAt }),
);
gateway.onShutdownRequest((reason) => void gracefulShutdown(reason));

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
} else if (selectedFrontend === "discord") {
  const { createDiscordFrontend } = await import("./frontend/discord/index.js");
  frontend = createDiscordFrontend(config, gateway);
  log("bot", "Frontend: Discord");
} else {
  const { createTelegramFrontend } =
    await import("./frontend/telegram/index.js");
  frontend = createTelegramFrontend(config, gateway);
  log("bot", "Frontend: Telegram");
}

// ── Create backend + wire dispatcher ─────────────────────────────────────────

const { backend } = await initBackendAndDispatcher(config, frontend);
gateway.backend = backend;

// Subscribe the gateway to chat-role rebinds so `/model`, `/settings`,
// shared-action dispatch, etc. all see the new backend the moment a
// rebind resolves. Heartbeat / dream / per-chat-override rebinds don't
// touch the gateway field — those roles run from their own getBackend
// providers (dispatcher routes per chat).
const { onBackendChange, roleHolder } =
  await import("./core/engine/backend-controller/index.js");
const CHAT_ROLE_HOLDER = roleHolder("chat");
onBackendChange((holder, newBackend, info) => {
  if (holder !== CHAT_ROLE_HOLDER) return;
  gateway.backend = newBackend;
  log("bot", `Gateway backend reference updated → ${info.label}`);
});

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
    const { destroyPlugins } = await import("./core/plugin/index.js");
    await destroyPlugins();
  }
  stopPulseTimer();
  stopHeartbeatTimer();
  await awaitHeartbeat();
  stopCronTimer();
  await shutdownTriggers();
  stopWatchdog();
  stopUploadCleanup();
  flushSessions();
  flushChatSettings();
  flushCronJobs();
  flushTriggers();
  flushHistory();
  flushMediaIndex();
  // Guarded removal: after a /restart handoff the successor has already
  // written its own pid here — deleting unconditionally would orphan it
  // (the bug that made `talon restart` spawn duplicate daemons).
  removePidRecordIfOwnedBy(process.pid);
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
  flushTriggers();
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
  startWatchdog(config.workspace);
  startUploadCleanup(config.workspace);

  await frontend.start();

  // Replay any runs that came due while Talon was down (per-job catch-up
  // policy; default skip = fast no-op), THEN start the live cron tick. Kicking
  // catch-up off first gives it the ~60s head start to take each replayed job's
  // in-flight lock before the first scheduled tick, so a replay can't race a
  // scheduled run. Fire-and-forget so a slow replay never blocks startup.
  runStartupCatchup().catch((err) =>
    logError("cron", "startup catch-up failed", err),
  );
  startCronTimer();
}

main().catch((err) => {
  logError("bot", "Fatal startup error", err);
  process.exit(1);
});
