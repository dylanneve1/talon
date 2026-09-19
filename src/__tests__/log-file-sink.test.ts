/**
 * The log file sink must never be able to kill the daemon.
 *
 * Incident 2026-09-18: the root disk filled, the raw `createWriteStream`
 * handed to `pino.multistream` emitted ENOSPC with no `error` listener,
 * and the resulting uncaught exception took the process down mid-restart
 * — no shutdown, no successor. `ResilientFileSink` owns the file stream
 * so pino never touches it: failures pause file logging, lines written
 * while paused are dropped and counted, and a backed-off timer reopens
 * the file when the disk comes back.
 *
 * The same day's second failure made the writes synchronous: a buffered
 * stream loses whatever is queued when `process.exit()` runs, which is
 * every line that explains why a daemon is exiting. See
 * ./log-exit-flush.test.ts for the end-to-end proof.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep log.ts's module-level initialization away from the real ~/.talon
// (it creates the dir and rotates an oversized log file at import time).
const fakePaths = vi.hoisted(() => {
  const root = `${process.env.TMPDIR ?? "/tmp"}/talon-log-sink-test-${process.pid}`;
  return {
    root,
    log: `${root}/talon.log`,
    config: `${root}/config.json`,
    respawnLog: `${root}/respawn.log`,
  };
});
vi.mock("../util/paths.js", () => ({
  dirs: { root: fakePaths.root },
  files: {
    log: fakePaths.log,
    config: fakePaths.config,
    respawnLog: fakePaths.respawnLog,
  },
}));
const pinoSpies = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("pino", () => ({
  default: Object.assign(() => pinoSpies, {
    multistream: vi.fn(() => ({ write: vi.fn() })),
  }),
}));
vi.mock("pino-pretty", () => ({
  default: () => ({ write: vi.fn(), on: vi.fn() }),
}));

const { ResilientFileSink, openSyncLogFile, log, logError, logWarn, logDebug } =
  await import("../util/log.js");
type SyncLogTarget = ReturnType<typeof openSyncLogFile>;

/** A target that fails every write the way a full disk does. */
function enospcTarget(): SyncLogTarget {
  return {
    write() {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
        code: "ENOSPC",
      });
    },
    close() {},
  };
}

describe("ResilientFileSink", () => {
  let dir: string;
  let notices: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "talon-sink-"));
    notices = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakePaths.root, { recursive: true, force: true });
  });

  it("survives ENOSPC, drops lines while paused, and resumes on the retry", async () => {
    vi.useFakeTimers();
    const logPath = join(dir, "talon.log");
    let opens = 0;
    const open = vi.fn((path: string) => {
      opens++;
      // First open: the disk is full. Second: it has been freed.
      return opens === 1 ? enospcTarget() : openSyncLogFile(path);
    });

    const sink = new ResilientFileSink(logPath, {
      open,
      retryMs: 30_000,
      notify: (level, message) => notices.push(`${level}: ${message}`),
    });
    // Nothing a sink does may reach pino — that is the whole point.
    expect(() => sink.write("before the disk filled\n")).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(sink.isDown).toBe(true);
    expect(notices[0]).toContain("Log file sink failed (ENOSPC)");
    expect(notices[0]).toContain("file logging paused");
    expect(notices[0]).toContain("retrying in 30s");

    // Paused: lines are dropped, never buffered, and the file is not
    // touched. The line that tripped the failure counts as dropped too —
    // with a synchronous write we know it never landed, where the old
    // stream reported success and learned otherwise a tick later.
    sink.write("dropped one\n");
    sink.write("dropped two\n");
    expect(sink.dropped).toBe(3);
    expect(existsSync(logPath)).toBe(false);

    // The retry timer reopens the file.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(open).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    sink.write("after the disk came back\n");
    // Synchronous by contract: the line is on the fd, not in a queue.
    expect(readFileSync(logPath, "utf-8")).toContain(
      "after the disk came back",
    );
    await Promise.resolve();
    expect(sink.isDown).toBe(false);
    expect(sink.dropped).toBe(0);
    expect(notices.at(-1)).toContain("file logging resumed");
    expect(notices.at(-1)).toContain("3 line(s) dropped");
  });

  it("backs off and warns only once while the disk stays full", async () => {
    vi.useFakeTimers();
    const open = vi.fn(() => enospcTarget());
    const sink = new ResilientFileSink(join(dir, "talon.log"), {
      open,
      retryMs: 30_000,
      maxRetryMs: 120_000,
      notify: (level, message) => notices.push(`${level}: ${message}`),
    });

    sink.write("one\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);

    // 30s → reopen (still full) → 60s → reopen → 120s (the ceiling).
    await vi.advanceTimersByTimeAsync(30_000);
    sink.write("two\n");
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(open).toHaveBeenCalledTimes(3);

    // One warning, not one per failure.
    expect(notices.filter((n) => n.startsWith("warn:"))).toHaveLength(1);
    expect(sink.isDown).toBe(true);
  });

  it("keeps going when the file cannot even be opened", async () => {
    vi.useFakeTimers();
    const open = vi.fn(() => {
      throw Object.assign(new Error("EACCES: permission denied, open"), {
        code: "EACCES",
      });
    });
    const sink = new ResilientFileSink(join(dir, "nope", "talon.log"), {
      open,
      retryMs: 30_000,
      notify: (level, message) => notices.push(`${level}: ${message}`),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(sink.isDown).toBe(true);
    expect(notices[0]).toContain("Log file sink failed (EACCES)");

    expect(() => sink.write("still logging elsewhere\n")).not.toThrow();
    expect(sink.dropped).toBe(1);
  });
});

describe("log functions", () => {
  it("never let a throwing sink escape to the caller", () => {
    // pino-pretty's SonicBoom throws "SonicBoom destroyed" on every write
    // once a failure has destroyed it — from inside a log call, which at
    // shutdown means from inside a signal or crash handler.
    const boom = () => {
      throw new Error("SonicBoom destroyed");
    };
    pinoSpies.info.mockImplementationOnce(boom);
    pinoSpies.error.mockImplementationOnce(boom);
    pinoSpies.warn.mockImplementationOnce(boom);
    pinoSpies.debug.mockImplementationOnce(boom);

    expect(() => log("shutdown", "SIGTERM received")).not.toThrow();
    expect(() => logError("bot", "Uncaught exception")).not.toThrow();
    expect(() => logWarn("bot", "suppressed EPIPE")).not.toThrow();
    expect(() => logDebug("bot", "detail")).not.toThrow();
  });
});
