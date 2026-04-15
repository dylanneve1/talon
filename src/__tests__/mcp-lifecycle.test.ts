/**
 * Integration tests for MCP server subprocess lifecycle.
 *
 * Spawns real MCP server processes (using the same SDK transport as
 * production) and verifies that closing stdin causes graceful exit.
 * This is the OS-agnostic teardown mechanism used during hot-reload.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FIXTURE = resolve(__dirname, "fixtures/test-mcp-server.ts");
const TSX_LOADER = pathToFileURL(
  resolve(__dirname, "../../node_modules/tsx/dist/esm/index.mjs"),
).href;
const STARTUP_TIMEOUT = 15_000;
const EXIT_TIMEOUT = 10_000;

// Track spawned processes for cleanup
const spawned: ChildProcess[] = [];

afterEach(() => {
  for (const child of spawned) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  spawned.length = 0;
});

function spawnMcpServer(
  env?: Record<string, string>,
): ChildProcess {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, FIXTURE], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  spawned.push(child);
  return child;
}

/** Wait for the server to write "READY\n" on stderr. */
function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("MCP server did not become ready in time")),
      STARTUP_TIMEOUT,
    );
    let buf = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!buf.includes("READY")) {
        reject(new Error(`MCP server exited early (code=${code}): ${buf}`));
      }
    });
  });
}

/** Wait for the process to exit, with a timeout. Returns exit code or null on timeout. */
function waitForExit(
  child: ChildProcess,
  timeoutMs = EXIT_TIMEOUT,
): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function isRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

describe("MCP server subprocess lifecycle", () => {
  it(
    "exits gracefully when stdin is closed",
    async () => {
      const server = spawnMcpServer();
      await waitForReady(server);

      expect(isRunning(server)).toBe(true);

      // Close stdin — this is what the SDK does when setMcpServers({}) is called
      server.stdin!.end();

      const exitCode = await waitForExit(server);
      expect(exitCode).toBe(0);
    },
    STARTUP_TIMEOUT + EXIT_TIMEOUT,
  );

  it(
    "old server exits while new server keeps running (reload simulation)",
    async () => {
      // Spawn "old" MCP server (as if loaded with first plugin config)
      const oldServer = spawnMcpServer({
        TALON_RELOAD_AT: "2024-01-01T00:00:00.000Z",
      });
      await waitForReady(oldServer);
      expect(isRunning(oldServer)).toBe(true);

      // Spawn "new" MCP server (as if reloaded with fresh plugin config)
      const newServer = spawnMcpServer({
        TALON_RELOAD_AT: "2024-01-01T00:01:00.000Z",
      });
      await waitForReady(newServer);
      expect(isRunning(newServer)).toBe(true);

      // Simulate two-phase teardown: close old server's stdin
      oldServer.stdin!.end();

      const oldExitCode = await waitForExit(oldServer);
      expect(oldExitCode).toBe(0);

      // New server must still be running
      expect(isRunning(newServer)).toBe(true);

      // Cleanup new server
      newServer.stdin!.end();
      await waitForExit(newServer);
    },
    2 * STARTUP_TIMEOUT + EXIT_TIMEOUT,
  );

  it(
    "multiple old servers all exit when their stdin is closed",
    async () => {
      // Spawn 3 servers (simulating accumulated orphans from repeated reloads)
      const servers = [];
      for (let i = 0; i < 3; i++) {
        const s = spawnMcpServer({ TALON_RELOAD_AT: `reload-${i}` });
        await waitForReady(s);
        servers.push(s);
      }

      for (const s of servers) expect(isRunning(s)).toBe(true);

      // Close stdin on all three simultaneously (simulating batch teardown)
      for (const s of servers) s.stdin!.end();

      // All three should exit cleanly
      const exits = await Promise.all(servers.map((s) => waitForExit(s)));
      expect(exits).toEqual([0, 0, 0]);
    },
    3 * STARTUP_TIMEOUT + EXIT_TIMEOUT,
  );
});
