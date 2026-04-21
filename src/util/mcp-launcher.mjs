#!/usr/bin/env node

/**
 * Supervises an MCP stdio child. Dies with the child when our own stdin
 * pipe closes, which happens whenever the Claude Agent SDK side goes away.
 */
import { spawn } from "node:child_process";

const [, , cmd, ...args] = process.argv;
if (!cmd) {
  process.stderr.write("mcp-launcher: missing command\n");
  process.exit(2);
}

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
child.stdout.pipe(process.stdout);
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
