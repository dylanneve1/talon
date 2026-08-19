/**
 * Self-respawn helper for /restart commands across frontends.
 *
 * Spawns a fresh copy of the current process — same Node binary,
 * same `execArgv` (preserving the tsx loader so `.ts` entrypoints
 * still resolve), same script + user args, same cwd + env. The new
 * child is detached with stdio:"ignore" so it survives the parent's
 * exit; calling `unref()` lets the parent exit without waiting on
 * it.
 *
 * Why not call the daemon's `talon restart` CLI? That path assumed
 * the bot was started via the daemon (talon.pid managed by
 * `daemonStart()`) and broke for anything else — `npm start`, `npx
 * tsx src/index.ts`, systemd, foreman, pm2, or running under a
 * debugger. Respawning from our own `process.argv` works regardless
 * of launch method.
 *
 * Ordering matters. `respawnSelf()` only *arms* the handoff and
 * raises SIGTERM; the successor is spawned by `spawnSuccessor()` at
 * the tail of graceful shutdown, once the frontends have stopped.
 * Spawning up-front (the previous behaviour) left the successor
 * long-polling `getUpdates` while the outgoing process was still
 * draining in-flight queries — up to DRAIN_TIMEOUT_MS of two live
 * pollers. Telegram answers only one of them and re-delivers the
 * unconfirmed updates to the other, so a restart mid-turn produced
 * a 409 Conflict on the way out and duplicate replies on the way in.
 * Releasing the poll before the successor binds it removes the
 * overlap rather than relying on grammy's 409 retry to paper over it.
 */

import { spawn } from "node:child_process";
import { log, logError } from "./log.js";

let pendingReason: string | null = null;

/**
 * Arm a respawn and raise SIGTERM on ourselves so the existing
 * graceful-shutdown path cleanly stops the frontends, flushes state,
 * and hands off via `spawnSuccessor()`.
 *
 * `reason` is logged for operator visibility (e.g. "telegram
 * /restart"). The function returns immediately; the successor starts
 * only after shutdown has released the Telegram long-poll.
 */
export function respawnSelf(reason: string): void {
  log("shutdown", `Respawn requested (${reason})`);
  pendingReason = reason;
  // SIGTERM triggers the graceful-shutdown handler in src/app.ts,
  // which stops the frontends, flushes state, spawns the successor,
  // and calls process.exit(0). Don't exit here directly — that would
  // skip the flush and leave the PID file dangling.
  process.kill(process.pid, "SIGTERM");
}

/** True when a `/restart` or `/update` armed a handoff. */
export function respawnRequested(): boolean {
  return pendingReason !== null;
}

/**
 * Spawn the successor process. Called at the end of graceful
 * shutdown, after the frontends have stopped — so the incoming
 * process binds Telegram's long-poll only once this one has let go
 * of it. No-op unless `respawnSelf()` armed a handoff.
 *
 * Never throws: a failed handoff must not prevent this process from
 * exiting. An external supervisor (systemd, pm2, the user's
 * terminal) can pick things up.
 */
export function spawnSuccessor(): void {
  if (pendingReason === null) return;
  const reason = pendingReason;
  pendingReason = null;

  try {
    const child = spawn(
      process.argv[0],
      [...process.execArgv, ...process.argv.slice(1)],
      {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      },
    );
    child.once("error", (err) => {
      logError(
        "shutdown",
        `Respawn failed; exiting without a successor — restart manually`,
        err,
      );
    });
    child.unref();
    log("shutdown", `Respawn child started (pid ${child.pid}) — ${reason}`);
  } catch (err) {
    logError(
      "shutdown",
      `Respawn failed; exiting without a successor — restart manually`,
      err,
    );
  }
}
