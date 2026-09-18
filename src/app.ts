/**
 * Talon — agentic AI harness.
 * Composition root: loads config, creates frontend + backend, wires dispatcher.
 *
 * Frontends (Telegram, Terminal) and backends (Claude, OpenCode)
 * are loaded dynamically — only the selected platform's dependencies are required.
 */

import { getFrontends } from "./core/config/index.js";
import { startUploadCleanup, stopUploadCleanup } from "./core/vfs/workspace.js";
import { flushDatabase } from "./storage/db.js";
import { getActiveCount, stopAllTurns } from "./core/engine/dispatcher.js";
import {
  startPulseTimer,
  stopPulseTimer,
} from "./core/background/pulse/pulse.js";
import { stopPlanAlerts } from "./core/background/pulse/plan-alerts.js";
import {
  startHeartbeatTimer,
  stopHeartbeatTimer,
  awaitCurrentRun as awaitHeartbeat,
} from "./core/background/heartbeat/index.js";
import {
  startCronTimer,
  stopCronTimer,
  runStartupCatchup,
} from "./core/background/cron/scheduler.js";
import { shutdownTriggers } from "./core/background/triggers/index.js";
import { pruneSettledTriggers } from "./storage/triggers.js";
import { startWatchdog, stopWatchdog } from "./util/watchdog.js";
import { spawnSuccessor } from "./core/daemon/respawn.js";
import { log, logError, logWarn } from "./util/log.js";
import { bootPhase, bootReport } from "./core/daemon/boot-timer.js";
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
  startFrontends,
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
import {
  recordBootMetrics,
  startResourceSampler,
  stopResourceSampler,
} from "./core/daemon/resource-sampler.js";

const { config } = await bootPhase("bootstrap", () => bootstrap());

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
await bootPhase("frontends create", async () => {
  for (const name of configuredFrontends) {
    const frontend = await createFrontendById(name, config, gateway);
    frontends.push(frontend);
    log("bot", `Frontend: ${getFrontendDescriptor(name)?.label ?? name}`);
  }
});

// ── Create backend + wire dispatcher ─────────────────────────────────────────

const { backend } = await bootPhase("backend + dispatcher", () =>
  initBackendAndDispatcher(config, frontends),
);
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
let triggerPruneTimer: ReturnType<typeof setInterval> | null = null;

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

  const deadlineAt = Date.now() + SHUTDOWN_TIMEOUT_MS;
  const forceTimer = setTimeout(() => {
    logError("shutdown", "Timeout exceeded, forcing exit");
    // Hand off even on the forced path. A restart must survive a
    // subsystem that won't stop (a wedged FUSE unmount, an MCP server
    // ignoring SIGTERM, a backend child that never acks): without this
    // the timeout exits without a successor and `/restart` silently
    // takes the daemon down for good. The successor may briefly race
    // the long-poll we failed to release, but grammy retries the 409 —
    // a few seconds of overlap beats staying down.
    spawnSuccessor();
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();

  // Drain in-flight queries. A turn can legitimately run for minutes, so a
  // drain that only waits can never succeed against one — ask every running
  // turn to abort first, then poll for the aborts to settle so backends can
  // flush partial state before the process exits.
  if (getActiveCount() > 0) {
    const aborted = stopAllTurns();
    log(
      "shutdown",
      `Waiting for ${getActiveCount()} in-flight queries to drain` +
        (aborted > 0 ? ` (abort requested for ${aborted})` : "") +
        `...`,
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

  // stop() takes the surface down AND awaits the run loop start() left
  // running, so a frontend is provably finished before the stores below
  // are flushed. The force timer above is the backstop for one that
  // won't end.
  await shutdownStep("frontends", () =>
    Promise.allSettled(frontends.map((frontend) => frontend.stop())),
  );
  // Tear down every instantiated backend, including per-chat overrides.
  // Checking only config.backend orphaned an OpenCode child whenever the
  // process default was Claude but one chat had switched to OpenCode.
  await shutdownStep("backend pool", async () => {
    const { cleanupBackendPool } =
      await import("./core/engine/backend-controller/index.js");
    await cleanupBackendPool();
  });
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
    // Cap the wait by what's left of the force-timer budget (minus margin
    // for the steps below). The default 10s wait plus a full 5s drain used
    // to consume the entire 15s budget, so a slow heartbeat tripped the
    // forced exit even though teardown was proceeding normally.
    await awaitHeartbeat(Math.max(0, deadlineAt - Date.now() - 3_000));
  });
  await shutdownStep("cron timer", stopCronTimer);
  await shutdownStep("plan alerts", stopPlanAlerts);
  await shutdownStep("trigger prune timer", () => {
    if (triggerPruneTimer) clearInterval(triggerPruneTimer);
    triggerPruneTimer = null;
  });
  await shutdownStep("triggers", shutdownTriggers);
  await shutdownStep("watchdog", stopWatchdog);
  await shutdownStep("resource sampler", stopResourceSampler);
  await shutdownStep("upload cleanup", stopUploadCleanup);
  await shutdownStep("mcp hub", async () => {
    const { shutdownHub } = await import("./core/mcp-hub/index.js");
    await shutdownHub();
  });
  flushDatabase();
  // Guarded removal: only clear the record if it still names us. A
  // successor that raced ahead and wrote its own pid here must not be
  // orphaned (the bug that made `talon restart` spawn duplicate daemons).
  removePidRecordIfOwnedBy(process.pid);
  log("shutdown", "State saved");
  // Hand off last: the frontends are stopped, so the successor binds
  // Telegram's long-poll only after we have released it. No-op unless
  // /restart or /update armed a respawn.
  spawnSuccessor();
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

  // Cron MUST start before the frontends are awaited: a long-polling
  // frontend's start() blocks for the entire process lifetime, so anything
  // sequenced after that await effectively runs at shutdown. (Regression
  // #396→3.5.0: startCronTimer() sat after the frontend await and no
  // scheduled job fired for 23 days.) Message delivery inside cron uses the
  // frontend's send API, which works as soon as init() has completed —
  // it does not depend on the polling loop being up.
  //
  // Catch-up replays runs that came due while Talon was down (per-job
  // policy; default for new jobs is "once"). Kicking it off first gives it
  // the ~60s head start to take each replayed job's in-flight lock before
  // the first scheduled tick, so a replay can't race a scheduled run.
  // Fire-and-forget so a slow replay never blocks startup.
  runStartupCatchup().catch((err) =>
    logError("cron", "startup catch-up failed", err),
  );
  startCronTimer();

  // Sweep settled triggers (fired/errored/cancelled/timed_out/terminated)
  // past their retention window so the trigger list doesn't accumulate
  // corpses forever. Once at boot, then daily.
  const pruned = pruneSettledTriggers();
  if (pruned > 0) log("triggers", `Pruned ${pruned} settled trigger(s)`);
  triggerPruneTimer = setInterval(
    () => {
      const n = pruneSettledTriggers();
      if (n > 0) log("triggers", `Pruned ${n} settled trigger(s)`);
    },
    24 * 60 * 60_000,
  );
  triggerPruneTimer.unref();

  // Every frontend's start() resolves when it is LISTENING, never when
  // it stops (contract in core/frontend-runtime/capabilities.ts): the
  // long-poll / reconnect loop lives inside the frontend and is awaited
  // by its stop(). So this await ends at the real end of the boot, and
  // what follows runs while the daemon is alive — not, as it once did,
  // hours later during shutdown.
  await bootPhase("frontends start", () => startFrontends(frontends));
  // Phase 0 accounting (docs/ts-migration-plan.md): the boot is over the
  // moment the frontends are listening, so the totals are folded into the
  // metrics store here, from the same uptime figure the log line prints.
  const bootMs = Math.round(process.uptime() * 1000);
  recordBootMetrics(bootMs);
  startResourceSampler();
  log("bot", `Ready in ${bootReport(bootMs)}`);

  // main() returning is not the process ending: the daemon stays alive on
  // the handles the frontends hold (gateway listener, bridge server,
  // long-poll, readline) until a signal reaches gracefulShutdown().
}

main().catch((err) => {
  logError("bot", "Fatal startup error", err);
  flushDatabase();
  removePidRecordIfOwnedBy(process.pid);
  process.exit(1);
});
