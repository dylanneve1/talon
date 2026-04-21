/**
 * MCP supervisor launcher.
 *
 * Every MCP stdio server Talon hands to the Claude Agent SDK is wrapped
 * through a checked-in Node supervisor:
 * `node src/util/mcp-launcher.mjs <real-cmd> [args...]`.
 *
 * The supervisor proxies stdio between the SDK and the real child, and
 * watches its own `process.stdin` for EOF. When the SDK's pipe closes —
 * for any reason, including Talon crashing or being SIGKILLed — the
 * kernel closes our stdin, we SIGTERM the child, then SIGKILL if it
 * hasn't exited within a short grace, then exit. No orphans, no /proc
 * scan, no per-plugin signature list.
 *
 * Talon now requires a normal source or package install with this launcher
 * file present on disk. Standalone bun-compiled binaries are unsupported.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LAUNCHER_PATH = fileURLToPath(
  new URL("./mcp-launcher.mjs", import.meta.url),
);

/**
 * Resolve the checked-in launcher script path and verify it exists on disk.
 */
export function ensureLauncher(): string {
  if (!existsSync(LAUNCHER_PATH)) {
    throw new Error(
      `MCP launcher missing at ${LAUNCHER_PATH}. Talon must run from a normal source or package install; bun-compiled binaries are not supported.`,
    );
  }
  return LAUNCHER_PATH;
}

type StdioServer = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

/**
 * Rewrite `{command, args}` so the real command runs under the launcher.
 *
 * Plugin-agnostic: the launcher doesn't know or care what it's supervising.
 * Platform-agnostic: relies on pipe EOF, which POSIX and Windows both
 * deliver when the parent end of a pipe is closed.
 */
export function wrapMcpServer<T extends StdioServer>(server: T): T {
  const launcher = ensureLauncher();
  return {
    ...server,
    command: "node",
    args: [launcher, server.command, ...server.args],
  };
}
