/**
 * Daemon control — start / stop / restart orchestration for the CLI.
 *
 * Replaces the old pidfile-only flow in cli.ts, which had two failure
 * modes that produced duplicate daemons fighting over Telegram's
 * getUpdates:
 *   - a lost pidfile (the /restart handoff bug) made `talon restart`
 *     report "not running" and spawn a second instance;
 *   - a fixed 2-second sleep between stop and start raced the old
 *     daemon's graceful shutdown (which takes up to 15s).
 *
 * All outcomes are returned as data — rendering is the CLI's job.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import {
  readPidRecord,
  writePidRecord,
  removePidRecordIfOwnedBy,
  isProcessAlive,
} from "./pidfile.js";
import {
  findRunningInstance,
  probeHealth,
  type RunningInstance,
} from "./discovery.js";

export type StartOutcome =
  | { ok: true; pid: number; port?: number }
  | { ok: false; reason: "already-running"; instance: RunningInstance }
  | { ok: false; reason: "spawn-failed"; detail?: string }
  | { ok: false; reason: "exited-early"; detail: string }
  /** The daemon may still be booting (slow plugin startup) — not fatal. */
  | { ok: false; reason: "boot-timeout" };

export type StopOutcome =
  | { stopped: true; pid: number; method: "http" | "sigterm" | "sigkill" }
  | { stopped: false; reason: "not-running" }
  | { stopped: false; reason: "unkillable"; pid: number };

const BOOT_WAIT_MS = 30_000;
/** Longer than the daemon's 15s graceful-shutdown force-exit timer. */
const STOP_WAIT_MS = 20_000;
const POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startDaemon(opts: {
  pkgRoot: string;
  pidfilePath?: string;
}): Promise<StartOutcome> {
  const existing = await findRunningInstance(opts.pidfilePath);
  if (existing) {
    // Heal a lost/stale pidfile so the next stop/restart can use the
    // fast path instead of rediscovering via port scan.
    if (existing.pidfileStale && existing.port) {
      writePidRecord(
        {
          pid: existing.pid,
          port: existing.port,
          startedAt: existing.health?.startedAt,
        },
        opts.pidfilePath,
      );
    }
    return { ok: false, reason: "already-running", instance: existing };
  }

  const before = readPidRecord(opts.pidfilePath);
  const entryScript = resolve(opts.pkgRoot, "src", "index.ts");

  // Spawn detached with stdio ignored.
  //
  // Invoke tsx's CLI entry directly via `node <tsx-cli.mjs> <entry>` rather
  // than `node --import tsx/dist/esm/index.mjs <entry>`. The --import loader
  // path triggered a tsx resolver bug where CJS `require('../../')` from
  // gramjs resolved to `index.jsx` instead of `index.js`, killing startup
  // silently in detached mode (stderr is /dev/null). Running tsx as a CLI
  // avoids the broken loader path while still working on Windows — `node
  // foo.mjs` bypasses the .cmd wrapper that motivated the loader approach.
  const tsxCli = resolve(
    opts.pkgRoot,
    "node_modules",
    "tsx",
    "dist",
    "cli.mjs",
  );
  let child;
  try {
    child = spawn(process.execPath, [tsxCli, entryScript], {
      cwd: opts.pkgRoot,
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
      windowsHide: true,
    });
  } catch (err) {
    return {
      ok: false,
      reason: "spawn-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!child.pid) return { ok: false, reason: "spawn-failed" };

  let exited: string | null = null;
  child.once("exit", (code, signal) => {
    exited = `exited with code ${code ?? "?"}${signal ? ` (signal ${signal})` : ""}`;
  });

  // Wait for the daemon to write its pidfile (with the gateway port)
  // and answer /health. The wrapper exiting before that means startup
  // failed — surface it instead of claiming success.
  try {
    const deadline = Date.now() + BOOT_WAIT_MS;
    while (Date.now() < deadline) {
      if (exited) return { ok: false, reason: "exited-early", detail: exited };
      const record = readPidRecord(opts.pidfilePath);
      if (record?.port && record.pid !== before?.pid) {
        const health = await probeHealth(record.port);
        if (health && (health.pid === undefined || health.pid === record.pid)) {
          return { ok: true, pid: record.pid, port: record.port };
        }
      }
      await sleep(POLL_MS);
    }
    return { ok: false, reason: "boot-timeout" };
  } finally {
    child.unref();
  }
}

async function requestShutdown(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

function trySignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* ESRCH — already gone */
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(POLL_MS);
  }
  return !isProcessAlive(pid);
}

export async function stopDaemon(
  opts: { pidfilePath?: string } = {},
): Promise<StopOutcome> {
  const instance = await findRunningInstance(opts.pidfilePath);
  if (!instance) {
    // Clear a stale pidfile so future starts/stops see a clean slate.
    const record = readPidRecord(opts.pidfilePath);
    if (record && !isProcessAlive(record.pid)) {
      removePidRecordIfOwnedBy(record.pid, opts.pidfilePath);
    }
    return { stopped: false, reason: "not-running" };
  }

  // Graceful first: POST /shutdown runs the daemon's full shutdown path
  // (frontend stop, state flushes). It is also the only graceful option
  // on Windows, where SIGTERM terminates without running handlers.
  let method: "http" | "sigterm" = "sigterm";
  if (instance.port && (await requestShutdown(instance.port))) {
    method = "http";
  } else {
    trySignal(instance.pid, "SIGTERM");
  }

  if (await waitForExit(instance.pid, STOP_WAIT_MS)) {
    // The daemon removes its own pidfile on graceful exit; clean up in
    // case it died before getting there.
    removePidRecordIfOwnedBy(instance.pid, opts.pidfilePath);
    return { stopped: true, pid: instance.pid, method };
  }

  trySignal(instance.pid, "SIGKILL");
  if (await waitForExit(instance.pid, 5_000)) {
    removePidRecordIfOwnedBy(instance.pid, opts.pidfilePath);
    return { stopped: true, pid: instance.pid, method: "sigkill" };
  }
  return { stopped: false, reason: "unkillable", pid: instance.pid };
}

export async function restartDaemon(opts: {
  pkgRoot: string;
  pidfilePath?: string;
}): Promise<{ stop: StopOutcome; start: StartOutcome }> {
  // stopDaemon waits for the old process to actually exit (no fixed
  // sleep), so the gateway port is free by the time we start — and the
  // gateway's EADDRINUSE fallback covers the rare straggler.
  const stop = await stopDaemon(opts);
  const start = await startDaemon(opts);
  return { stop, start };
}
