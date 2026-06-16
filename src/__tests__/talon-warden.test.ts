/**
 * talon-warden — the Rust supervision harness (native/talon-warden)
 * that fronts trigger children for the trigger supervisor. It puts the
 * child in its own process group, frames stdout/stderr as NDJSON
 * events, enforces the timeout out of process, and tears the whole
 * tree down on cancellation or parent death.
 *
 * These tests build the warden with the pinned Rust toolchain and
 * drive the real binary, asserting the behaviours that matter for a
 * process that supervises arbitrary bot-authored scripts: protocol
 * framing and ordering, exit-code/signal reporting, group kills that
 * reach grandchildren, TERM forwarding, parent-death teardown, and
 * byte-capped UTF-8-safe lines.
 *
 * If cargo is not installed the suite skips — the CI Warden job builds
 * with the pinned toolchain, mirroring how talon-driver's suite runs
 * only where zig lives.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const wardenDir = fileURLToPath(
  new URL("../../native/talon-warden", import.meta.url),
);

function findCargo(): string | null {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return "cargo";
  } catch {
    return null;
  }
}

const cargo = findCargo();
const isWindows = process.platform === "win32";
// The behavioural suite drives bash scripts and POSIX signals, so it
// runs on Unix; Windows gets a focused smoke suite over the real .exe
// (spawn, NDJSON framing, exit codes) below. Both need cargo.
const suite = cargo && !isWindows ? describe : describe.skip;
const winSuite = cargo && isWindows ? describe : describe.skip;
if (!cargo) {
  console.warn("talon-warden tests skipped: cargo toolchain not found");
}

type WardenEvent = Record<string, unknown>;

interface WardenRun {
  events: WardenEvent[];
  status: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  what = "condition",
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

suite("talon-warden harness", () => {
  let wardenBin: string;
  let root: string;
  const liveChildren: ChildProcess[] = [];

  beforeAll(() => {
    // --locked: the committed Cargo.lock is the dependency record; a
    // drifted lockfile should fail here, not resolve silently.
    execFileSync(cargo!, ["build", "--release", "--locked"], {
      cwd: wardenDir,
      stdio: "inherit",
    });
    wardenBin = join(wardenDir, "target", "release", "talon-warden");
    root = mkdtempSync(join(tmpdir(), "talon-warden-test-"));
  }, 180_000);

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const child of liveChildren.splice(0)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  /** Spawn the warden and resolve with all events once it exits. */
  function runWarden(
    args: string[],
    opts: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<WardenRun> {
    return new Promise((resolve, reject) => {
      const child = spawn(wardenBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...opts.env },
      });
      liveChildren.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (status, signal) => {
        const events = stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as WardenEvent);
        resolve({ events, status, signal, stderr });
      });
    });
  }

  /** Spawn the warden and stream events; the caller drives lifecycle. */
  function streamWarden(args: string[]): {
    child: ChildProcess;
    events: WardenEvent[];
    closed: Promise<{ status: number | null; signal: NodeJS.Signals | null }>;
  } {
    const child = spawn(wardenBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    liveChildren.push(child);
    const events: WardenEvent[] = [];
    let buffer = "";
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") events.push(JSON.parse(line) as WardenEvent);
      }
    });
    const closed = new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.on("close", (status, signal) => resolve({ status, signal })),
    );
    return { child, events, closed };
  }

  // ── Protocol basics ────────────────────────────────────────────────

  it("reports its version", () => {
    const out = execFileSync(wardenBin, ["--version"], { encoding: "utf-8" });
    expect(out).toMatch(/^talon-warden \d+\.\d+\.\d+\n$/);
  });

  it("rejects bad usage with exit 2 and a usage message", async () => {
    const noTimeout = await runWarden(["--", "true"]);
    expect(noTimeout.status).toBe(2);
    expect(noTimeout.stderr).toContain("usage:");

    const noCommand = await runWarden(["--timeout-ms=1000"]);
    expect(noCommand.status).toBe(2);

    const junkFlag = await runWarden([
      "--timeout-ms=1000",
      "--bogus",
      "--",
      "true",
    ]);
    expect(junkFlag.status).toBe(2);
  });

  it("frames start → lines → exit for a clean run", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--",
      "bash",
      "-c",
      'echo one; echo "TALON_FIRE: ping"; echo err-line >&2; exit 0',
    ]);
    expect(run.status).toBe(0);

    const [start, ...rest] = run.events;
    expect(start.event).toBe("start");
    expect(start.pid).toBeGreaterThan(0);
    if (process.platform === "linux") {
      expect(typeof start.pidStarttime).toBe("number");
    }

    const lines = rest.filter((e) => e.event === "line");
    const stdoutLines = lines.filter((e) => e.stream === "stdout");
    expect(stdoutLines.map((e) => e.text)).toEqual(["one", "TALON_FIRE: ping"]);
    expect(lines.find((e) => e.stream === "stderr")?.text).toBe("err-line");

    const exit = run.events.at(-1)!;
    expect(exit).toMatchObject({
      event: "exit",
      code: 0,
      signal: null,
      timedOut: false,
      reason: "exited",
    });
    expect(typeof exit.durationMs).toBe("number");
  });

  it("passes the child's env and argv through", async () => {
    const run = await runWarden(
      [
        "--timeout-ms=10000",
        "--",
        "bash",
        "-c",
        'echo "$TALON_TRIGGER_ID:$1"',
        "argv0",
        "argv-one",
      ],
      { env: { TALON_TRIGGER_ID: "trig_test" } },
    );
    expect(run.events.find((e) => e.event === "line")?.text).toBe(
      "trig_test:argv-one",
    );
  });

  it("reports non-zero exit codes", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--",
      "bash",
      "-c",
      "exit 7",
    ]);
    expect(run.status).toBe(0); // supervision itself succeeded
    expect(run.events.at(-1)).toMatchObject({ event: "exit", code: 7 });
  });

  it("reports the signal that killed the child by name", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--",
      "bash",
      "-c",
      "kill -TERM $$",
    ]);
    expect(run.events.at(-1)).toMatchObject({
      event: "exit",
      code: null,
      signal: "SIGTERM",
      reason: "exited",
    });
  });

  it("emits an error event and exits 3 when the command cannot spawn", async () => {
    const run = await runWarden([
      "--timeout-ms=1000",
      "--",
      "/nonexistent/never-a-binary",
    ]);
    expect(run.status).toBe(3);
    expect(run.events).toHaveLength(1);
    expect(run.events[0].event).toBe("error");
    expect(String(run.events[0].message)).toContain("spawn failed");
  });

  // ── Line discipline ────────────────────────────────────────────────

  it("caps line length without splitting UTF-8 and flags truncation", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--max-line-bytes=16",
      "--",
      "bash",
      "-c",
      // 14 ASCII bytes then multi-byte chars crossing the 16-byte cap.
      'printf "aaaaaaaaaaaaaaééé\\nok\\n"',
    ]);
    const lines = run.events.filter((e) => e.event === "line");
    expect(lines[0].truncated).toBe(true);
    const text = String(lines[0].text);
    expect(text.startsWith("aaaaaaaaaaaaaa")).toBe(true);
    expect(text).not.toContain("�"); // never a manufactured replacement char
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16);
    expect(lines[1]).toMatchObject({ text: "ok", truncated: false });
  });

  it("round-trips multi-byte output intact", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--",
      "bash",
      "-c",
      'echo "naïve 🦀 — done"',
    ]);
    expect(run.events.find((e) => e.event === "line")?.text).toBe(
      "naïve 🦀 — done",
    );
  });

  // ── Tree teardown ──────────────────────────────────────────────────

  it("enforces the timeout and kills the whole process group", async () => {
    const begun = Date.now();
    const run = await runWarden([
      "--timeout-ms=300",
      "--grace-ms=200",
      "--",
      "bash",
      "-c",
      "sleep 300 & echo grandchild=$!; sleep 300",
    ]);
    expect(Date.now() - begun).toBeLessThan(5_000);
    expect(run.events.at(-1)).toMatchObject({
      event: "exit",
      timedOut: true,
      reason: "timeout",
      signal: "SIGTERM",
    });

    const grandchild = Number(
      String(run.events.find((e) => e.event === "line")?.text).split("=")[1],
    );
    expect(grandchild).toBeGreaterThan(0);
    await waitFor(() => !isAlive(grandchild), 5_000, "grandchild reap");
  });

  it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const begun = Date.now();
    const run = await runWarden([
      "--timeout-ms=200",
      "--grace-ms=300",
      "--",
      "bash",
      "-c",
      "trap '' TERM; echo armed; sleep 300",
    ]);
    expect(Date.now() - begun).toBeLessThan(8_000);
    expect(run.events.at(-1)).toMatchObject({
      event: "exit",
      timedOut: true,
      reason: "timeout",
      signal: "SIGKILL",
    });
  });

  it("sweeps surviving grandchildren when the child exits cleanly", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--",
      "bash",
      "-c",
      "sleep 300 & echo grandchild=$!",
    ]);
    expect(run.events.at(-1)).toMatchObject({ event: "exit", code: 0 });
    const grandchild = Number(
      String(run.events.find((e) => e.event === "line")?.text).split("=")[1],
    );
    expect(grandchild).toBeGreaterThan(0);
    await waitFor(() => !isAlive(grandchild), 5_000, "grandchild sweep");
  });

  it("forwards SIGTERM to the group and reports reason=signal", async () => {
    const { child, events, closed } = streamWarden([
      "--timeout-ms=60000",
      "--grace-ms=500",
      "--",
      "bash",
      "-c",
      "echo up; sleep 300",
    ]);
    await waitFor(
      () => events.some((e) => e.event === "line" && e.text === "up"),
      5_000,
      "child startup line",
    );
    const childPid = Number(events.find((e) => e.event === "start")?.pid);

    child.kill("SIGTERM");
    const { status } = await closed;
    expect(status).toBe(0);
    expect(events.at(-1)).toMatchObject({
      event: "exit",
      reason: "signal",
      timedOut: false,
    });
    await waitFor(() => !isAlive(childPid), 5_000, "child teardown");
  });

  it("tears the tree down when its parent dies (orphan-free contract)", async () => {
    // Launch the warden from a short-lived intermediate bash so its
    // parent exits while the supervised child still runs. The warden
    // must notice (pdeathsig on Linux, ppid polling elsewhere), kill
    // the child, and report parent-exit. Events land in a file because
    // the intermediate shell is gone. The intermediate must outlive
    // warden startup (the ppid baseline is captured then) — in
    // production the parent is a long-lived Talon, and a parent that
    // dies inside the spawn window is caught by the EPIPE backstop on
    // the start event instead.
    const outFile = join(root, `parent-exit-${Date.now()}.ndjson`);
    execFileSync("bash", [
      "-c",
      `"${wardenBin}" --timeout-ms=60000 --grace-ms=500 -- sleep 300 > "${outFile}" 2>/dev/null & sleep 0.3`,
    ]);

    const { readFileSync } = await import("node:fs");
    let events: WardenEvent[] = [];
    await waitFor(
      () => {
        try {
          events = readFileSync(outFile, "utf-8")
            .split("\n")
            .filter((l) => l.trim() !== "")
            .map((l) => JSON.parse(l) as WardenEvent);
        } catch {
          return false;
        }
        return events.some((e) => e.event === "exit");
      },
      10_000,
      "parent-exit event",
    );

    expect(events.at(-1)).toMatchObject({
      event: "exit",
      reason: "parent-exit",
    });
    const childPid = Number(events.find((e) => e.event === "start")?.pid);
    await waitFor(() => !isAlive(childPid), 5_000, "orphan teardown");
  });

  // ── TS boundary (src/native/warden.ts) over the real binary ───────

  it("drives the typed wrapper end-to-end", async () => {
    process.env.TALON_WARDEN = wardenBin;
    const { spawnWarden, _resetWardenCacheForTesting } =
      await import("../native/warden.js");
    _resetWardenCacheForTesting();
    try {
      const lines: string[] = [];
      let startPid = 0;
      const exit = await new Promise<unknown>((resolve, reject) => {
        const handle = spawnWarden({
          command: "bash",
          args: ["-c", "echo alpha; echo beta >&2; exit 3"],
          timeoutMs: 10_000,
          graceMs: 500,
          env: process.env,
          onStart: (e) => (startPid = e.pid),
          onLine: (e) => lines.push(`${e.stream}:${e.text}`),
          onExit: resolve,
          onSpawnError: reject,
        });
        expect(handle).not.toBeNull();
      });
      expect(startPid).toBeGreaterThan(0);
      expect(lines).toContain("stdout:alpha");
      expect(lines).toContain("stderr:beta");
      expect(exit).toMatchObject({ code: 3, reason: "exited" });
    } finally {
      delete process.env.TALON_WARDEN;
      _resetWardenCacheForTesting();
    }
  });

  it("synthesizes exactly one terminal event when the warden is SIGKILLed", async () => {
    process.env.TALON_WARDEN = wardenBin;
    const { spawnWarden, _resetWardenCacheForTesting } =
      await import("../native/warden.js");
    _resetWardenCacheForTesting();
    try {
      let exits = 0;
      let spawnErrors = 0;
      let reason = "";
      const handle = spawnWarden({
        command: "bash",
        args: ["-c", "echo up; sleep 300"],
        timeoutMs: 60_000,
        graceMs: 500,
        env: process.env,
        onStart: () => {},
        onLine: () => {},
        onExit: (e) => {
          exits += 1;
          reason = e.reason;
        },
        onSpawnError: () => {
          spawnErrors += 1;
        },
      })!;
      liveChildren.push(handle);
      await waitFor(() => handle.pid !== undefined, 2_000, "warden pid");
      // Give the start event time to arrive, then SIGKILL the warden —
      // no protocol exit event can follow.
      await new Promise((r) => setTimeout(r, 300));
      handle.kill("SIGKILL");
      await waitFor(() => exits + spawnErrors > 0, 5_000, "terminal callback");
      await new Promise((r) => setTimeout(r, 200)); // would surface doubles
      expect(exits).toBe(1);
      expect(spawnErrors).toBe(0);
      expect(reason).toBe("warden-lost");
    } finally {
      delete process.env.TALON_WARDEN;
      _resetWardenCacheForTesting();
    }
  });
});

/**
 * Windows smoke suite — the Job Object harness over the real
 * talon-warden.exe. The POSIX behavioural suite above drives bash and
 * signals; here we assert the platform-agnostic protocol contract on
 * Windows (spawn, NDJSON framing, exit-code reporting, usage/spawn
 * errors) using `cmd` builtins. Tree-teardown timing (CTRL_BREAK grace,
 * job kill of grandchildren, parent-death) is left to a follow-up that
 * adds Windows-native equivalents of the bash teardown cases.
 */
winSuite("talon-warden harness (windows)", () => {
  let wardenBin: string;
  const liveChildren: ChildProcess[] = [];

  beforeAll(() => {
    execFileSync(cargo!, ["build", "--release", "--locked"], {
      cwd: wardenDir,
      stdio: "inherit",
    });
    wardenBin = join(wardenDir, "target", "release", "talon-warden.exe");
  }, 180_000);

  afterEach(() => {
    for (const child of liveChildren.splice(0)) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  });

  function runWarden(args: string[]): Promise<WardenRun> {
    return new Promise((resolve, reject) => {
      const child = spawn(wardenBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      liveChildren.push(child);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (status, signal) => {
        const events = stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as WardenEvent);
        resolve({ events, status, signal, stderr });
      });
    });
  }

  it("reports its version", () => {
    const out = execFileSync(wardenBin, ["--version"], { encoding: "utf-8" });
    expect(out).toMatch(/^talon-warden \d+\.\d+\.\d+/);
  });

  it("rejects bad usage with exit 2 and a usage message", async () => {
    const noTimeout = await runWarden(["--", "cmd", "/c", "exit 0"]);
    expect(noTimeout.status).toBe(2);
    expect(noTimeout.stderr).toContain("usage:");
  });

  it("frames start → line → exit for a clean run", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--",
      "cmd",
      "/c",
      "echo hello",
    ]);
    expect(run.status).toBe(0);

    const start = run.events[0];
    expect(start.event).toBe("start");
    expect(Number(start.pid)).toBeGreaterThan(0);

    const lines = run.events.filter((e) => e.event === "line");
    // cmd's echo can carry a trailing space before the newline; trim it.
    expect(lines.some((e) => String(e.text).trim() === "hello")).toBe(true);

    const exit = run.events.at(-1)!;
    expect(exit).toMatchObject({
      event: "exit",
      code: 0,
      signal: null,
      timedOut: false,
      reason: "exited",
    });
  });

  it("reports non-zero exit codes", async () => {
    const run = await runWarden([
      "--timeout-ms=10000",
      "--",
      "cmd",
      "/c",
      "exit 7",
    ]);
    expect(run.status).toBe(0); // supervision itself succeeded
    expect(run.events.at(-1)).toMatchObject({ event: "exit", code: 7 });
  });

  it("emits an error event and exits 3 when the command cannot spawn", async () => {
    const run = await runWarden([
      "--timeout-ms=1000",
      "--",
      "C:\\nonexistent\\never-a-binary.exe",
    ]);
    expect(run.status).toBe(3);
    expect(run.events).toHaveLength(1);
    expect(run.events[0].event).toBe("error");
    expect(String(run.events[0].message)).toContain("spawn failed");
  });

  it("enforces the timeout and reports reason=timeout", async () => {
    const begun = Date.now();
    // ping as a portable sleep: ~3s of waiting, deadline fires first.
    const run = await runWarden([
      "--timeout-ms=300",
      "--grace-ms=200",
      "--",
      "cmd",
      "/c",
      "ping -n 30 127.0.0.1 >NUL",
    ]);
    expect(Date.now() - begun).toBeLessThan(8_000);
    expect(run.events.at(-1)).toMatchObject({
      event: "exit",
      timedOut: true,
      reason: "timeout",
    });
  });
});
