/**
 * Orphan MCP cleanup — sweeps zombie MCP subprocesses left behind by a
 * previous Talon process that died without cleaning up its children.
 *
 * When Talon restarts, the Claude Agent SDK subprocess dies but some MCP
 * server subprocesses survive (reparented to init, PPID=1). On the next
 * start, these orphans still hold ports, websocket connections, and state
 * — causing the fresh Talon's MCP clients to conflict when connecting to
 * the same endpoints (notably Camoufox via shared ws path).
 *
 * This module runs ONCE at startup, finds orphaned MCP processes (PPID=1
 * + known MCP command-line pattern), and terminates them. Linux only —
 * reads /proc/<pid>/stat and /proc/<pid>/cmdline directly, no shell out.
 */

import { readdirSync, readFileSync } from "node:fs";
import { log, logWarn } from "./log.js";

/**
 * Command-line path signatures that uniquely identify a Talon-spawned MCP
 * subprocess. Each entry is a substring we expect to find on the FULL
 * argv string, chosen to be specific enough that unrelated processes on
 * the host — e.g. a different user's `polymarket` daemon — never match.
 *
 * Rule of thumb: prefer `/talon.plugins.x/` over `x`, prefer
 * `/node_modules/@playwright/mcp/cli.js` over `@playwright/mcp`. When in
 * doubt, lean narrower — a missed orphan is safer than a wrongful kill.
 */
const MCP_SIGNATURES: readonly string[] = [
  "/node_modules/@playwright/mcp/cli.js",
  "/node_modules/@modelcontextprotocol/server-",
  "/node_modules/.bin/brave-search-mcp-server",
  "/.npm-global/bin/brave-search-mcp-server",
  "/.npm-global/bin/ssh-mcp-server",
  "/.npm-global/bin/mcp-hetzner",
  // Path suffix, not project directory — the checkout dir is install-specific
  // (can be anything), so matching "/telegram-claude-agent/" would miss forks
  // or renamed clones.
  "/src/core/tools/mcp-server.ts",
  "/.talon/wikipedia-mcp-venv/",
  "/.talon/mempalace-venv/",
  "/talon.plugins.extras/",
  "/talon.plugins.ffmpeg/",
  "/talon.plugins.email/",
  "/talon.plugins.x-twitter/",
  "/talon.plugins.tailscale/",
  "/talon.plugins.firecrawl/",
  "/talon.plugins.polymarket/",
  "/talon.plugins.github/",
  "/talon.plugins.ssh/",
  "/talon.plugins.hetzner/",
  "/talon.plugins.playwright/",
  "/talon.plugins.mempalace/",
];

export type OrphanCleanupResult = {
  found: number;
  killed: number;
  failed: number;
  details: { pid: number; cmd: string; killed: boolean }[];
};

/**
 * Snapshot of a candidate MCP orphan. `starttime` is field 22 of
 * /proc/<pid>/stat — monotonic jiffies since boot — and is the cheapest
 * stable identifier we have for a Linux process. Capturing it up front
 * lets us verify the PID hasn't been recycled before issuing SIGKILL.
 */
type OrphanSnapshot = { pid: number; cmd: string; starttime: number };

/** Override the /proc root for tests. Defaults to "/proc". */
export function cleanOrphanedMcpProcesses(
  procRoot = "/proc",
): Promise<OrphanCleanupResult> {
  return doCleanup(procRoot);
}

async function doCleanup(procRoot: string): Promise<OrphanCleanupResult> {
  const result: OrphanCleanupResult = {
    found: 0,
    killed: 0,
    failed: 0,
    details: [],
  };

  if (process.platform !== "linux") {
    // /proc parsing is Linux-only. macOS/BSD/Windows no-op quietly so
    // startup doesn't log a spurious warning on every boot.
    return result;
  }

  let pidDirs: string[];
  try {
    pidDirs = readdirSync(procRoot).filter((name) => /^\d+$/.test(name));
  } catch (err) {
    logWarn(
      "watchdog",
      `Could not read ${procRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const orphans: OrphanSnapshot[] = [];
  for (const dir of pidDirs) {
    const pid = Number.parseInt(dir, 10);
    // Skip self, direct parent.
    if (pid === process.pid || pid === process.ppid) continue;

    const stat = readStat(`${procRoot}/${dir}/stat`);
    if (!stat || stat.ppid !== 1) continue;

    const cmd = readCmdline(`${procRoot}/${dir}/cmdline`);
    if (!cmd) continue;

    if (!MCP_SIGNATURES.some((sig) => cmd.includes(sig))) continue;

    orphans.push({ pid, cmd, starttime: stat.starttime });
  }

  result.found = orphans.length;
  if (orphans.length === 0) return result;

  log(
    "watchdog",
    `Found ${orphans.length} orphaned MCP process(es); terminating`,
  );

  // Track orphans where a real SIGTERM went out vs ones that were already
  // gone (ESRCH). Only the former can still be alive after the grace period,
  // so the SIGKILL follow-up is skipped entirely when everything was ESRCH.
  // We keep the full snapshot (not just pid) so we can verify identity via
  // starttime before SIGKILL — prevents clobbering an unrelated process that
  // happened to inherit a recycled PID during the 500ms grace window.
  const sigtermed: OrphanSnapshot[] = [];

  for (const orphan of orphans) {
    const { pid, cmd } = orphan;
    let killed = false;
    try {
      process.kill(pid, "SIGTERM");
      killed = true;
      result.killed++;
      sigtermed.push(orphan);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") {
        // Already gone between listing and kill — count as success but
        // don't queue for a SIGKILL grace check.
        killed = true;
        result.killed++;
      } else {
        result.failed++;
        logWarn(
          "watchdog",
          `Failed to SIGTERM pid=${pid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const short = cmd.length > 100 ? cmd.slice(0, 97) + "..." : cmd;
    log("watchdog", `  ${killed ? "killed" : "failed"} pid=${pid} — ${short}`);
    result.details.push({ pid, cmd, killed });
  }

  // Follow-up SIGKILL on anything that ignored SIGTERM. Skip entirely when
  // no real SIGTERM was actually sent (e.g. all orphans were already-ESRCH).
  if (sigtermed.length > 0) {
    await new Promise((r) => setTimeout(r, 500));
    for (const { pid, starttime: expectedStart } of sigtermed) {
      // Re-read starttime and verify it hasn't changed. If the PID has been
      // recycled (original exited, new unrelated process took the slot), the
      // starttime value will differ — in that case, skip the SIGKILL instead
      // of nuking a stranger. Also handles the vanished-entirely case: an
      // ENOENT on /proc/<pid>/stat means the process is gone, nothing to do.
      const currentStart = readStartTime(`${procRoot}/${pid}/stat`);
      if (currentStart < 0) continue; // gone
      if (currentStart !== expectedStart) {
        logWarn(
          "watchdog",
          `  pid=${pid} starttime changed (${expectedStart} → ${currentStart}); PID recycled, skipping SIGKILL`,
        );
        continue;
      }
      try {
        process.kill(pid, "SIGKILL");
        log("watchdog", `  SIGKILL'd stubborn pid=${pid}`);
      } catch {
        /* raced with exit between starttime check and kill — fine */
      }
    }
  }

  return result;
}

/**
 * Parse PPID and starttime from /proc/<pid>/stat, skipping past the
 * parenthesised comm field which can contain spaces/parens of its own.
 * Returns null on failure.
 *
 * Fields after the last ')' (0-indexed from the stat(5) layout minus the
 * first three pid/comm/state columns):
 *   [0] state
 *   [1] ppid
 *   [2] pgrp
 *   [3] session
 *   [4] tty_nr
 *   [5] tpgid
 *   [6] flags
 *   [7] minflt
 *   [8] cminflt
 *   [9] majflt
 *   [10] cmajflt
 *   [11] utime
 *   [12] stime
 *   [13] cutime
 *   [14] cstime
 *   [15] priority
 *   [16] nice
 *   [17] num_threads
 *   [18] itrealvalue
 *   [19] starttime   ← field 22 of the full stat row
 */
function readStat(
  statPath: string,
): { ppid: number; starttime: number } | null {
  let raw: string;
  try {
    raw = readFileSync(statPath, "utf8");
  } catch {
    return null;
  }
  const lastParen = raw.lastIndexOf(")");
  if (lastParen < 0) return null;
  const after = raw
    .slice(lastParen + 2)
    .trim()
    .split(/\s+/);
  const ppid = Number.parseInt(after[1] ?? "", 10);
  const starttime = Number.parseInt(after[19] ?? "", 10);
  if (!Number.isFinite(ppid) || !Number.isFinite(starttime)) return null;
  return { ppid, starttime };
}

/** Fast-path starttime lookup for the SIGKILL recycle check. Returns -1 on failure. */
function readStartTime(statPath: string): number {
  const stat = readStat(statPath);
  return stat ? stat.starttime : -1;
}

/** Parse full command line from /proc/<pid>/cmdline (null-separated argv). */
function readCmdline(cmdlinePath: string): string | null {
  try {
    const raw = readFileSync(cmdlinePath, "utf8");
    // cmdline is argv joined with \0 and (often) a trailing \0 — split on
    // the null byte and re-join with space. Avoids a control-char regex.
    const NUL = "\0";
    const parts = raw.split(NUL).filter((p) => p.length > 0);
    return parts.join(" ").trim();
  } catch {
    return null;
  }
}
