/**
 * Tests for log.ts module-level initialization code.
 * Uses vi.resetModules() + vi.doMock() to control the file system state
 * during module load so we can cover the initialization branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("log.ts — module-level initialization branches", () => {
  const mockMkdirSync = vi.fn();
  const mockRenameSync = vi.fn();
  const mockUnlinkSync = vi.fn();
  const mockLogFn = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    mockMkdirSync.mockClear();
    mockRenameSync.mockClear();
    mockUnlinkSync.mockClear();
    mockLogFn.mockClear();
    delete process.env.TALON_QUIET;
  });

  afterEach(() => {
    delete process.env.TALON_QUIET;
  });

  it("creates .talon dir when it does not exist (line 39 TRUE branch)", async () => {
    vi.doMock("../util/paths.js", () => ({
      dirs: { root: "/fake/.talon" },
      files: {
        log: "/fake/.talon/talon.log",
        errorLog: "/fake/.talon/errors.log",
        config: "/fake/.talon/config.json",
      },
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false), // root dir doesn't exist
      mkdirSync: mockMkdirSync,
      statSync: vi.fn(() => ({ size: 0 })),
      renameSync: mockRenameSync,
      unlinkSync: mockUnlinkSync,
      readFileSync: vi.fn(() => "{}"),
    }));
    vi.doMock("pino", () => ({
      default: () => ({
        level: "trace",
        info: mockLogFn,
        error: mockLogFn,
        warn: mockLogFn,
        debug: mockLogFn,
        trace: mockLogFn,
        fatal: mockLogFn,
        child: vi.fn(() => ({
          level: "trace",
          info: mockLogFn,
          error: mockLogFn,
          warn: mockLogFn,
          debug: mockLogFn,
          trace: mockLogFn,
          fatal: mockLogFn,
        })),
      }),
    }));

    await import("../util/log.js");

    // mkdirSync should have been called to create the missing root dir
    expect(mockMkdirSync).toHaveBeenCalledWith("/fake/.talon", {
      recursive: true,
    });
  });

  it("rotates log file when it exceeds 10MB (line 46 TRUE branch)", async () => {
    vi.doMock("../util/paths.js", () => ({
      dirs: { root: "/fake/.talon" },
      files: {
        log: "/fake/.talon/talon.log",
        errorLog: "/fake/.talon/errors.log",
        config: "/fake/.talon/config.json",
      },
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true), // both root dir and log file exist
      mkdirSync: mockMkdirSync,
      statSync: vi.fn(() => ({ size: 11 * 1024 * 1024 })), // > 10MB → triggers rotation
      renameSync: mockRenameSync,
      unlinkSync: mockUnlinkSync,
      readFileSync: vi.fn(() => "{}"),
    }));
    vi.doMock("pino", () => ({
      default: () => ({
        level: "trace",
        info: mockLogFn,
        error: mockLogFn,
        warn: mockLogFn,
        debug: mockLogFn,
        trace: mockLogFn,
        fatal: mockLogFn,
        child: vi.fn(() => ({
          level: "trace",
          info: mockLogFn,
          error: mockLogFn,
          warn: mockLogFn,
          debug: mockLogFn,
          trace: mockLogFn,
          fatal: mockLogFn,
        })),
      }),
    }));

    await import("../util/log.js");

    // renameSync should have been called to rotate the oversized log file
    expect(mockRenameSync).toHaveBeenCalledWith(
      "/fake/.talon/talon.log",
      "/fake/.talon/talon.log.old",
    );
  });

  it("skips config read when TALON_QUIET=1 (line 59 FALSE branch: if(!quiet) not entered)", async () => {
    process.env.TALON_QUIET = "1";
    vi.doMock("../util/paths.js", () => ({
      dirs: { root: "/fake/.talon" },
      files: {
        log: "/fake/.talon/talon.log",
        errorLog: "/fake/.talon/errors.log",
        config: "/fake/.talon/config.json",
      },
    }));
    const readFileSyncMock = vi.fn(() => "{}");
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      mkdirSync: mockMkdirSync,
      statSync: vi.fn(() => ({ size: 0 })),
      renameSync: mockRenameSync,
      unlinkSync: mockUnlinkSync,
      readFileSync: readFileSyncMock,
    }));
    vi.doMock("pino", () => ({
      default: () => ({
        level: "trace",
        info: mockLogFn,
        error: mockLogFn,
        warn: mockLogFn,
        debug: mockLogFn,
        trace: mockLogFn,
        fatal: mockLogFn,
        child: vi.fn(() => ({
          level: "trace",
          info: mockLogFn,
          error: mockLogFn,
          warn: mockLogFn,
          debug: mockLogFn,
          trace: mockLogFn,
          fatal: mockLogFn,
        })),
      }),
    }));

    await import("../util/log.js");

    // When TALON_QUIET=1, quiet=true before `if (!quiet)` — readFileSync for config never called
    const configCalls = readFileSyncMock.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("config"),
    );
    expect(configCalls).toHaveLength(0);
  });
});
