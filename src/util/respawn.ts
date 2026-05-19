/**
 * Self-respawn helper for /restart commands across frontends.
 *
 * Spawns a fresh copy of the current process — same Node binary,
 * same `execArgv` (preserving the tsx loader so `.ts` entrypoints
 * still resolve), same script + user args, same cwd + env — then
 * triggers a graceful shutdown of the current process. The new
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
 * Shutdown is done by raising SIGTERM on ourselves rather than
 * `process.exit(0)` so the existing graceful-shutdown handler runs
 * (`await frontend.stop()`, flush sessions, remove PID file). The
 * brief overlap between the new child binding Telegram's long-poll
 * and the old one releasing it is benign — grammy retries on 409
 * Conflict and the new child takes over within a few seconds.
 */

import { spawn } from "node:child_process";
import { log, logError } from "./log.js";

/**
 * Respawn the current process with identical argv + flags, then
 * raise SIGTERM on ourselves so the existing graceful-shutdown path
 * cleanly stops the frontend, flushes state, and exits.
 *
 * `reason` is logged for operator visibility (e.g. "telegram
 * /restart"). The function returns immediately; the actual exit
 * happens asynchronously once the child has spawned (or failed).
 */
export function respawnSelf(reason: string): void {
  log("shutdown", `Respawn requested (${reason})`);

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

  child.once("spawn", () => {
    log("shutdown", `Respawn child started (pid ${child.pid}) — exiting self`);
    child.unref();
    // SIGTERM triggers the existing graceful-shutdown handler in
    // src/index.ts, which stops the frontend, flushes state, and
    // calls process.exit(0). Don't exit here directly — that would
    // skip the flush and leave the PID file dangling.
    process.kill(process.pid, "SIGTERM");
  });

  child.once("error", (err) => {
    logError(
      "shutdown",
      `Respawn failed; exiting without a successor — restart manually`,
      err,
    );
    // The child never started, so we can't hand off. Still exit so
    // any external supervisor (systemd, pm2, the user's terminal)
    // can pick things up.
    process.kill(process.pid, "SIGTERM");
  });
}
