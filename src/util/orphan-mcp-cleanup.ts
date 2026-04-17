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

/** Command-line signatures we consider to be MCP server subprocesses. */
const MCP_SIGNATURES: readonly string[] = [
  "@playwright/mcp",
  "@modelcontextprotocol/server-",
  "brave-search-mcp-server",
  "ssh-mcp-server",
  "mcp-hetzner",
  "mcp-server.ts", // Talon's own per-frontend tool server
  "wikipedia_mcp",
  "mempalace.mcp_server",
  "x-mcp",
  "gmail-mcp",
  "firecrawl-mcp",
  "polymarket", // Polymarket plugin
];

export type OrphanCleanupResult = {
  found: number;
  killed: number;
  failed: number;
  details: { pid: number; cmd: string; killed: boolean }[];
};

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

  if (process.platform === "win32") {
    // Windows orphan detection is very different — skip for now.
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

  const orphans: { pid: number; cmd: string }[] = [];
  for (const dir of pidDirs) {
    const pid = Number.parseInt(dir, 10);
    // Skip self, direct parent.
    if (pid === process.pid || pid === process.ppid) continue;

    const ppid = readPpid(`${procRoot}/${dir}/stat`);
    if (ppid !== 1) continue;

    const cmd = readCmdline(`${procRoot}/${dir}/cmdline`);
    if (!cmd) continue;

    if (!MCP_SIGNATURES.some((sig) => cmd.includes(sig))) continue;

    orphans.push({ pid, cmd });
  }

  result.found = orphans.length;
  if (orphans.length === 0) return result;

  log(
    "watchdog",
    `Found ${orphans.length} orphaned MCP process(es); terminating`,
  );

  for (const { pid, cmd } of orphans) {
    let killed = false;
    try {
      process.kill(pid, "SIGTERM");
      killed = true;
      result.killed++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ESRCH") {
        // Already gone between listing and kill — count as success.
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

  // Follow-up: SIGKILL any stragglers after a short grace period.
  if (result.killed > 0) {
    await new Promise((r) => setTimeout(r, 500));
    for (const { pid } of orphans) {
      try {
        process.kill(pid, 0); // existence check only
        process.kill(pid, "SIGKILL");
        log("watchdog", `  SIGKILL'd stubborn pid=${pid}`);
      } catch {
        /* already gone */
      }
    }
  }

  return result;
}

/** Parse PPID from /proc/<pid>/stat. Returns -1 on failure. */
function readPpid(statPath: string): number {
  let raw: string;
  try {
    raw = readFileSync(statPath, "utf8");
  } catch {
    return -1;
  }
  // Format: "pid (comm) state ppid ..."  where comm can contain spaces and
  // parens, so we find the last ')' and read from there.
  const lastParen = raw.lastIndexOf(")");
  if (lastParen < 0) return -1;
  const after = raw
    .slice(lastParen + 2)
    .trim()
    .split(/\s+/);
  // after[0] = state, after[1] = ppid
  const ppid = Number.parseInt(after[1] ?? "", 10);
  return Number.isFinite(ppid) ? ppid : -1;
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
