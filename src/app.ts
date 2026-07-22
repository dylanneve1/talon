/**
 * Talon — agentic AI harness.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * Frontends (Telegram, Terminal) and backends (Claude, OpenCode)
 * are loaded dynamically — only the selected platform's dependencies are required.
 */

import { getFrontends } from "./util/config.js";
import { startUploadCleanup, stopUploadCleanup } from "./util/workspace.js";
import { flushDatabase } from "./storage/db.js";
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
import {
  getVfs,
  mountNamespaceFs,
  unmountNamespaceFs,
} from "./core/vfs/index.js";
import { bootstrap, initBackendAndDispatcher } from "./bootstrap.js";
import { Gateway } from "./core/engine/gateway.js";
import {
  createFrontendById,
  getFrontendDescriptor,
} from "./core/frontend-runtime/index.js";
import type { Frontend } from "./bootstrap.js";
// Attach every built-in frontend's create() to its registry descriptor.
// Adding a frontend is strictly additive: drop a factory.ts under the
// new frontend dir and list it in frontend/factories.ts.
import "./frontend/factories.js";

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

const configuredFrontends = [...new Set(getFrontends(config))];

const frontends: Frontend[] = [];
for (const name of configuredFrontends) {
  const frontend = await createFrontendById(name, config, gateway);
  frontends.push(frontend);
  log("bot", `Frontend: ${getFrontendDescriptor(name)?.label ?? name}`);
}

// ── Create backend + wire dispatcher ─────────────────────────────────────────

const { backend } = await initBackendAndDispatcher(config, frontends);
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
const DRAIN_TIMEOUT_MS = 5_000;

/**
 * One best-effort teardown step. A failing subsystem (a frontend that
 * won't stop, a plugin that throws in destroy, a dynamic import that
 * fails mid-shutdown) must not abort the rest of the sequence — the
 * WAL checkpoint and pidfile removal below have to run regardless.
 */
async function shutdownStep(name: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logError("shutdown", `${name} failed`, err);
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

  // Drain in-flight queries: poll instead of a fixed sleep, so an idle
  // daemon exits immediately and a busy one gets the full budget.
  if (getActiveCount() > 0) {
    log(
      "shutdown",
      `Waiting for ${getActiveCount()} in-flight queries to drain...`,
    );
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (getActiveCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const remaining = getActiveCount();
    if (remaining > 0) {
      logWarn(
        "shutdown",
        `Drain timed out with ${remaining} queries still in flight`,
      );
    }
  }

  await shutdownStep("frontends", () =>
    Promise.allSettled(frontends.map((frontend) => frontend.stop())),
  );
  if (config.backend === "opencode") {
    await shutdownStep("opencode server", async () => {
      const { stopOpenCodeServer } =
        await import("./backend/opencode/index.js");
      stopOpenCodeServer();
    });
  }
  // Destroy plugins (cleanup resources)
  if (config.plugins.length > 0) {
    await shutdownStep("plugins", async () => {
      const { destroyPlugins } = await import("./core/plugin/index.js");
      await destroyPlugins();
    });
  }
  await shutdownStep("fuse layer", unmountNamespaceFs);
  await shutdownStep("pulse timer", stopPulseTimer);
  await shutdownStep("heartbeat", async () => {
    stopHeartbeatTimer();
    await awaitHeartbeat();
  });
  await shutdownStep("cron timer", stopCronTimer);
  await shutdownStep("triggers", shutdownTriggers);
  await shutdownStep("watchdog", stopWatchdog);
  await shutdownStep("upload cleanup", stopUploadCleanup);
  await shutdownStep("mcp hub", async () => {
    const { shutdownHub } = await import("./core/mcp-hub/index.js");
    await shutdownHub();
  });
  flushDatabase();
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
  flushDatabase();
  // Same pid-guarded removal as the graceful path — a crashed daemon
  // must not leave a record that makes `talon status` chase a dead or
  // recycled pid.
  removePidRecordIfOwnedBy(process.pid);
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
  // Namespace on disk first: symlink farm always, live views (proc/,
  // plugins/) via FUSE when the host can. Bounded and never-throwing —
  // a host without FUSE boots identically, minus live views.
  await mountNamespaceFs({ mode: config.fuse, vfs: getVfs() });

  await Promise.all(frontends.map((frontend) => frontend.init()));
  log("bot", "Starting Talon...");

  if (config.pulse) startPulseTimer(config.pulseIntervalMs);
  if (config.heartbeat) startHeartbeatTimer(config.heartbeatIntervalMinutes);
  startWatchdog(config.workspace);
  startUploadCleanup(config.workspace);

  // A stdin-reading frontend (terminal) blocks in start() for the
  // process lifetime — run it without awaiting alongside the others.
  const stdinFrontends = frontends.filter(
    (frontend) => getFrontendDescriptor(frontend.name)?.sharesStdin === true,
  );
  const blockingFrontends = frontends.filter(
    (frontend) => !stdinFrontends.includes(frontend),
  );
  if (stdinFrontends.length > 0 && frontends.length > 1) {
    log(
      "bot",
      "Terminal frontend shares stdin with the other frontends; it will run alongside them without blocking startup.",
    );
  }
  await Promise.all(blockingFrontends.map((frontend) => frontend.start()));
  for (const frontend of stdinFrontends) {
    void frontend
      .start()
      .catch((err) =>
        logError("bot", `Terminal frontend start failed: ${String(err)}`),
      );
  }

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
  flushDatabase();
  removePidRecordIfOwnedBy(process.pid);
  process.exit(1);
});
