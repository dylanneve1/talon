import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { runStreaming, runProbe } from "../../../plugins/common/subprocess.js";
import { createProgressLogger } from "../../../plugins/common/progress.js";

/**
 * Fake ChildProcess for unit tests. Emits arbitrary stdout/stderr chunks
 * and fires `close` with a caller-provided exit code. No real subprocess.
 *
 * Tests here target the pieces that are easy to get wrong without coverage:
 *   - line splitting (carriage returns, CRLF, partial lines across chunks)
 *   - error classification propagation
 *   - the probe fast-path (stderr ignored on success, null on failure)
 */

interface FakeOpts {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  emitError?: NodeJS.ErrnoException;
  emitAfterMs?: number;
}

function fakeSpawn(opts: FakeOpts = {}) {
  return (_cmd: string, _args: readonly string[], _spawnOpts: SpawnOptions) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: (signal?: NodeJS.Signals | number) => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;

    const schedule = (fn: () => void) => {
      setTimeout(fn, opts.emitAfterMs ?? 0);
    };

    schedule(() => {
      if (opts.emitError) child.emit("error", opts.emitError);
      for (const c of opts.stdoutChunks ?? []) child.stdout.write(c);
      for (const c of opts.stderrChunks ?? []) child.stderr.write(c);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", opts.exitCode ?? 0, opts.signal ?? null);
    });

    return child as unknown as ChildProcess;
  };
}

function silentTracker() {
  const logger = createProgressLogger({
    component: "plugin",
    sink: () => {},
    now: () => 0,
  });
  return logger.step("test");
}

describe("runStreaming", () => {
  it("captures stdout + stderr, reports ok on exit 0", async () => {
    const spawnImpl = fakeSpawn({
      stdoutChunks: ["hello ", "world\n"],
      stderrChunks: ["warn 1\n"],
      exitCode: 0,
    });
    const result = await runStreaming("echo", ["hi"], {
      timeoutMs: 1_000,
      tracker: silentTracker(),
      spawnImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("warn 1\n");
    expect(result.exitCode).toBe(0);
  });

  it("streams each complete line to the tracker exactly once", async () => {
    const streamed: string[] = [];
    const logger = createProgressLogger({
      component: "plugin",
      sink: () => {},
      now: () => 0,
    });
    const step = logger.step("x");
    const origStream = step.stream.bind(step);
    step.stream = (line: string) => {
      streamed.push(line);
      return origStream(line);
    };

    // Intentionally split lines across chunks (common with pip / docker
    // output): one chunk ends mid-line, the next completes it and begins
    // another. The line buffering must stitch them back.
    const spawnImpl = fakeSpawn({
      stdoutChunks: ["Installing...\nDow", "nloading wheel\r\n", "Done\n"],
      exitCode: 0,
    });
    await runStreaming("fake", [], {
      timeoutMs: 1_000,
      tracker: step,
      spawnImpl,
    });
    expect(streamed).toEqual(["Installing...", "Downloading wheel", "Done"]);
  });

  it("normalizes CR-only progress output (docker pull style)", async () => {
    const streamed: string[] = [];
    const logger = createProgressLogger({
      component: "plugin",
      sink: () => {},
      now: () => 0,
    });
    const step = logger.step("x");
    step.stream = (line: string) => streamed.push(line);

    // docker pull emits \r to overwrite progress lines — our line
    // buffer must treat them as separators too or streams would never
    // flush until exit.
    const spawnImpl = fakeSpawn({
      stdoutChunks: ["Pulling\rLayer 1 20%\rLayer 1 done\nLayer 2 done\n"],
      exitCode: 0,
    });
    await runStreaming("fake", [], {
      timeoutMs: 1_000,
      tracker: step,
      spawnImpl,
    });
    expect(streamed).toEqual([
      "Pulling",
      "Layer 1 20%",
      "Layer 1 done",
      "Layer 2 done",
    ]);
  });

  it("flushes trailing content that lacks a final newline", async () => {
    // Regression: pip sometimes writes a status line without \n at the very
    // end of output. Previously we'd hold it in the line buffer forever and
    // the progress tracker never saw it — making logs incomplete.
    const streamed: string[] = [];
    const logger = createProgressLogger({
      component: "plugin",
      sink: () => {},
      now: () => 0,
    });
    const step = logger.step("x");
    step.stream = (line: string) => streamed.push(line);

    const spawnImpl = fakeSpawn({
      // No trailing newline on the last chunk — simulates a CLI that exits
      // after printing a final status line unterminated.
      stdoutChunks: ["Collecting mempalace\nSuccessfully installed"],
      exitCode: 0,
    });
    await runStreaming("pip", ["install"], {
      timeoutMs: 1_000,
      tracker: step,
      spawnImpl,
    });
    expect(streamed).toEqual([
      "Collecting mempalace",
      "Successfully installed",
    ]);
  });

  it("classifies spawn ENOENT as executable-not-found", async () => {
    const spawnImpl = fakeSpawn({
      emitError: Object.assign(new Error("spawn ENOENT"), {
        code: "ENOENT",
      }) as NodeJS.ErrnoException,
      exitCode: null,
    });
    const result = await runStreaming("nonexistent-cmd", [], {
      timeoutMs: 1_000,
      tracker: silentTracker(),
      spawnImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("executable-not-found");
  });

  it("classifies non-zero exit with network-error stderr as kind=network", async () => {
    const spawnImpl = fakeSpawn({
      stderrChunks: [
        "ERROR: Could not resolve host: pypi.org\nConnection refused\n",
      ],
      exitCode: 1,
    });
    const result = await runStreaming("pip", ["install", "mempalace"], {
      timeoutMs: 1_000,
      tracker: silentTracker(),
      spawnImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("network");
  });

  it("reports timeout signal kills as kind=timeout", async () => {
    const spawnImpl = fakeSpawn({
      exitCode: null,
      signal: "SIGKILL",
    });
    const result = await runStreaming("sleep", ["99"], {
      timeoutMs: 1_000,
      tracker: silentTracker(),
      spawnImpl,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("timeout");
  });
});

describe("runProbe", () => {
  it("returns trimmed stdout on success", async () => {
    const spawnImpl = fakeSpawn({
      stdoutChunks: ["  3.3.2\n"],
      exitCode: 0,
    });
    const result = await runProbe("python", ["-c", "..."], {
      timeoutMs: 1_000,
      spawnImpl,
    });
    expect(result).toBe("3.3.2");
  });

  it("returns null on non-zero exit (probes never throw)", async () => {
    const spawnImpl = fakeSpawn({
      stderrChunks: ["ModuleNotFoundError: No module named 'mempalace'\n"],
      exitCode: 1,
    });
    const result = await runProbe("python", ["-c", "import mempalace"], {
      timeoutMs: 1_000,
      spawnImpl,
    });
    expect(result).toBeNull();
  });
});
