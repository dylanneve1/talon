#!/usr/bin/env node

/**
 * Supervises an MCP stdio child. Two independent kill signals trigger
 * graceful child shutdown:
 *
 *   1. Our own `process.stdin` closes — the SDK-side pipe is gone, so the
 *      MCP child's protocol counterpart is dead. This catches the
 *      "Claude SDK process exits" case for the in-process Claude SDK.
 *
 *   2. `TALON_BRIDGE_URL/health` stops responding for
 *      `BRIDGE_FAILURES_BEFORE_EXIT` consecutive pings — Talon's gateway
 *      has gone away. This catches the "kilo serve / opencode serve
 *      outlives Talon" case: those daemons stay running across Talon
 *      restarts and keep our stdin open, so EOF alone doesn't help. The
 *      MCP child's bridge URL points at a port that isn't accepting
 *      connections any more, so the tools it exposes can't be answered;
 *      better to die and let kilo/opencode notice the stdio close +
 *      drop the registration.
 *
 * Both paths terminate the child the same way: SIGTERM, then SIGKILL
 * after a short grace period.
 */
import { spawn } from "node:child_process";

const [, , cmd, ...args] = process.argv;
if (!cmd) {
  process.stderr.write("mcp-launcher: missing command\n");
  process.exit(2);
}

const BRIDGE_URL = process.env.TALON_BRIDGE_URL;
// Ping cadence and tolerance are sized so a Talon restart that takes ~30s
// doesn't kill MCP children, but a permanent Talon-down state evicts them
// within ~1 minute.
const BRIDGE_PING_INTERVAL_MS = 15_000;
const BRIDGE_PING_TIMEOUT_MS = 2_000;
const BRIDGE_FAILURES_BEFORE_EXIT = 4;

const child = spawn(cmd, args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
});

// Any pipe end-point can throw EPIPE if the other side closes mid-write.
// We silence those; the exit and close paths already drive shutdown.
const swallow = () => {};
child.stdin.on("error", swallow);
child.stdout.on("error", swallow);
child.stderr.on("error", swallow);
process.stdin.on("error", swallow);
process.stdout.on("error", swallow);
process.stderr.on("error", swallow);

process.stdin.pipe(child.stdin);

// Stdout filter: MCP stdio convention says child stdout carries one
// JSON-RPC message per line and nothing else. Some plugins violate
// this and print log/banner lines (tailscale-mcp, ccusage, polymarket
// at startup). Strict MCP clients (the Python `mcp` library used by
// the Antigravity SDK) hit those lines, raise a JSONDecodeError, and
// crash the task group that owns the session — taking down every
// other MCP server connection in the process.
//
// Filter line-by-line: anything that looks like JSON (`{` or `[`
// after optional whitespace) goes through to stdout; everything else
// gets re-routed to stderr with a tag so it's still visible in logs.
// Tolerant MCP clients (e.g. the claude binary) see exactly what they
// did before — this is a no-op for clean servers.
{
  // Quick discriminator: a JSON-RPC line must start with `{` (objects).
  // The MCP spec permits array batches (`[`) but our plugins only emit
  // objects, and several plugins log lines that START with `[` (e.g.
  // tailscale-mcp's `[ISO-timestamp] [INFO] …`). Restrict to `{` and
  // verify it's parseable JSON before forwarding, so a stray
  // `{ tip: "..." }` shell-style line that isn't valid JSON still
  // goes to stderr.
  const looksJson = (line) => {
    const s = line.trimStart();
    if (s.length === 0 || s[0] !== "{") return false;
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  };
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl + 1);
      buf = buf.slice(nl + 1);
      if (looksJson(line)) {
        process.stdout.write(line);
      } else if (line.trim().length > 0) {
        process.stderr.write(`[mcp-launcher: stdout→stderr] ${line}`);
      }
    }
  });
  child.stdout.on("end", () => {
    if (buf.length === 0) return;
    if (looksJson(buf)) {
      process.stdout.write(buf);
    } else {
      process.stderr.write(`[mcp-launcher: stdout→stderr] ${buf}`);
    }
    buf = "";
  });
}

child.stderr.pipe(process.stderr);

let terminating = false;

function terminate(exitCode) {
  if (terminating) return;
  terminating = true;
  try {
    child.kill("SIGTERM");
  } catch {}
  const force = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 1000);
  force.unref?.();
  child.once("exit", () => {
    clearTimeout(force);
    process.exit(exitCode);
  });
}

process.stdin.on("end", () => terminate(0));
process.stdin.on("close", () => terminate(0));

child.once("exit", (code, signal) => {
  if (terminating) return;
  process.exit(code ?? (signal ? 1 : 0));
});
child.once("error", (err) => {
  process.stderr.write(`mcp-launcher: spawn error: ${err.message}\n`);
  process.exit(1);
});

const signals =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT"]
    : ["SIGTERM", "SIGINT", "SIGHUP"];
for (const sig of signals) {
  process.on(sig, () => terminate(0));
}

// Bridge-health watchdog. Only enabled when TALON_BRIDGE_URL is set
// (every Talon-spawned MCP server has it; ad-hoc launcher uses without
// the env var keep the legacy stdin-EOF-only behavior).
if (BRIDGE_URL) {
  let consecutiveFailures = 0;
  const tick = async () => {
    if (terminating) return;
    try {
      const resp = await fetch(`${BRIDGE_URL}/health`, {
        signal: AbortSignal.timeout(BRIDGE_PING_TIMEOUT_MS),
      });
      if (resp.ok) {
        consecutiveFailures = 0;
        return;
      }
      consecutiveFailures += 1;
    } catch {
      consecutiveFailures += 1;
    }
    if (consecutiveFailures >= BRIDGE_FAILURES_BEFORE_EXIT) {
      // Talon's gateway is gone. The MCP child has nothing useful to
      // serve — bridge calls would 404 against a dead port — so shut
      // down. Kilo/OpenCode notice the stdio close on the next interaction
      // and drop the MCP registration on their side.
      process.stderr.write(
        `mcp-launcher: bridge ${BRIDGE_URL} unreachable for ${
          consecutiveFailures * (BRIDGE_PING_INTERVAL_MS / 1000)
        }s; shutting down child\n`,
      );
      terminate(0);
    }
  };
  // Stagger first tick so a process-wide restart doesn't have every
  // launcher pinging the bridge in lockstep.
  const initialDelay = Math.floor(Math.random() * BRIDGE_PING_INTERVAL_MS);
  const startTimer = setTimeout(() => {
    void tick();
    const interval = setInterval(() => void tick(), BRIDGE_PING_INTERVAL_MS);
    interval.unref?.();
  }, initialDelay);
  startTimer.unref?.();
}
