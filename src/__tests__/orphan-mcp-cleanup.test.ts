/**
 * Tests for the orphan MCP sweep. We build a fake /proc-like directory
 * tree and point cleanOrphanedMcpProcesses at it, then assert it kills
 * the right PIDs and leaves the rest alone.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

// Stub process.kill so we don't actually SIGTERM the test runner. Restored
// in afterAll so the spy doesn't leak into sibling test files running in
// the same Vitest worker.
const killMock = vi.spyOn(process, "kill").mockImplementation(() => true);

// cleanOrphanedMcpProcesses no-ops on non-linux platforms. Tests here run the
// Linux branch against a fake /proc fixture, so pin process.platform to
// "linux" for the whole file and restore the original descriptor afterwards.
// Using `configurable: true` so the same property can be redefined later
// (the "non-linux no-op" test spoofs it per-case).
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
) ?? {
  value: process.platform,
  writable: false,
  enumerable: true,
  configurable: true,
};
Object.defineProperty(process, "platform", {
  value: "linux",
  writable: false,
  enumerable: true,
  configurable: true,
});

afterAll(() => {
  killMock.mockRestore();
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
});

// Build a fake /proc/<pid> entry.
function makeProc(
  root: string,
  pid: number,
  ppid: number,
  cmdline: string,
  comm = "node",
): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  // /proc/<pid>/stat — simulate kernel format: "pid (comm) state ppid ..."
  writeFileSync(
    join(dir, "stat"),
    `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`,
  );
  // /proc/<pid>/cmdline — null-separated argv
  writeFileSync(join(dir, "cmdline"), cmdline.replace(/ /g, "\0") + "\0");
}

let procRoot: string;

beforeEach(() => {
  killMock.mockClear();
  procRoot = join(
    tmpdir(),
    `orphan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(procRoot, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(procRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("cleanOrphanedMcpProcesses", () => {
  it("returns found=0 when proc root contains nothing matching", async () => {
    makeProc(procRoot, 1234, 1, "/usr/bin/nothing-interesting");
    makeProc(procRoot, 5678, 42, "/usr/bin/also-nothing");
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.found).toBe(0);
    expect(result.killed).toBe(0);
    expect(killMock).not.toHaveBeenCalledWith(1234, "SIGTERM");
    expect(killMock).not.toHaveBeenCalledWith(5678, "SIGTERM");
  });

  it("finds and kills orphans (PPID=1) matching MCP signatures", async () => {
    makeProc(
      procRoot,
      2578560,
      1,
      "node /home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js --endpoint ws://localhost:9222/abc",
    );
    makeProc(procRoot, 9999, 1, "node /home/dylan/.npm-global/bin/mcp-hetzner");
    makeProc(procRoot, 3000, 100, "/usr/bin/live-child-of-other-parent");
    makeProc(procRoot, 4000, 1, "/usr/bin/not-an-mcp-process");

    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.found).toBe(2);
    expect(result.killed).toBe(2);
    expect(result.failed).toBe(0);

    const sigterms = killMock.mock.calls
      .filter((c) => c[1] === "SIGTERM")
      .map((c) => c[0])
      .sort((a, b) => (a as number) - (b as number));
    expect(sigterms).toEqual([9999, 2578560]);
  });

  it("ignores processes whose parent is still alive (PPID != 1)", async () => {
    makeProc(
      procRoot,
      1111,
      222,
      "node /home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js",
    );
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.found).toBe(0);
    expect(killMock).not.toHaveBeenCalledWith(1111, "SIGTERM");
  });

  it("handles ESRCH (already gone) as success", async () => {
    makeProc(
      procRoot,
      1234,
      1,
      "node /home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js",
    );
    killMock.mockImplementationOnce(() => {
      const err = new Error("ESRCH") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.killed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("counts failures when SIGTERM throws non-ESRCH", async () => {
    makeProc(
      procRoot,
      1234,
      1,
      "node /home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js",
    );
    killMock.mockImplementationOnce(() => {
      const err = new Error("EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.killed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("gracefully handles missing proc root", async () => {
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(
      "/nonexistent/path/definitely/not/there",
    );
    expect(result.found).toBe(0);
    expect(killMock).not.toHaveBeenCalled();
  });

  it("no-ops on non-linux platforms without touching the proc root", async () => {
    // Spoof platform so the early-return branch runs. configurable: true
    // is required here (and in the file-level pin above) because the
    // property needs to be redefined again after the try block — without
    // it a subsequent Object.defineProperty throws on some Node versions.
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      writable: false,
      enumerable: true,
      configurable: true,
    });
    try {
      makeProc(
        procRoot,
        1234,
        1,
        "node /home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js",
      );
      const { cleanOrphanedMcpProcesses } =
        await import("../util/orphan-mcp-cleanup.js");
      const result = await cleanOrphanedMcpProcesses(procRoot);
      expect(result.found).toBe(0);
      expect(killMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  });

  it("matches only Talon-owned path markers, not bare substrings", async () => {
    // A random user's polymarket daemon that ISN'T under /talon.plugins.
    // should NOT be swept (this was the specific concern in review).
    makeProc(
      procRoot,
      8001,
      1,
      "node /opt/some-other-app/polymarket/server.js",
    );
    // A playwright process from a different project's node_modules also no.
    makeProc(
      procRoot,
      8002,
      1,
      "node /home/someoneelse/otherproj/playwright-test.js",
    );
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.found).toBe(0);
    expect(killMock).not.toHaveBeenCalledWith(8001, "SIGTERM");
    expect(killMock).not.toHaveBeenCalledWith(8002, "SIGTERM");
  });

  it("never kills self (current Talon PID)", async () => {
    makeProc(
      procRoot,
      process.pid,
      1,
      "node /home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js",
    );
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.found).toBe(0);
    expect(killMock).not.toHaveBeenCalledWith(process.pid, "SIGTERM");
  });

  it("parses cmdline with comm containing parens correctly", async () => {
    // Write stat with weird comm — (node (worker))  — should still parse PPID
    const pid = 7777;
    const dir = join(procRoot, String(pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "stat"),
      `${pid} (weird (evil) name) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`,
    );
    writeFileSync(
      join(dir, "cmdline"),
      "node\0/home/dylan/telegram-claude-agent/node_modules/@playwright/mcp/cli.js\0",
    );
    const { cleanOrphanedMcpProcesses } =
      await import("../util/orphan-mcp-cleanup.js");
    const result = await cleanOrphanedMcpProcesses(procRoot);
    expect(result.found).toBe(1);
    expect(result.killed).toBe(1);
  });
});
