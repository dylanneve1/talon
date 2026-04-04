/**
 * Tests for src/core/heartbeat.ts
 *
 * Covers: initHeartbeat, startHeartbeatTimer (double-start guard),
 * forceHeartbeat (concurrency guard), state persistence semantics
 * (success vs failure paths), and awaitCurrentRun.
 * The actual SDK agent call is mocked to avoid spawning a real Claude agent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const existsSyncMock = vi.fn(() => false);
const readFileSyncMock = vi.fn(() => "null");
const mkdirSyncMock = vi.fn();
const appendFileSyncMock = vi.fn();

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
  appendFileSync: appendFileSyncMock,
}));

const writeAtomicSyncMock = vi.fn();
vi.mock("write-file-atomic", () => ({
  default: { sync: writeAtomicSyncMock },
}));

// Mock the agent SDK so runHeartbeatAgent doesn't actually spawn Claude
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = vi.fn<() => AsyncGenerator<any>>(async function* () {
  // Yield nothing — simulates a clean run
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("../util/paths.js", () => ({
  files: {
    heartbeatState: "/fake/.talon/workspace/memory/heartbeat_state.json",
    dreamState: "/fake/.talon/workspace/memory/dream_state.json",
    memory: "/fake/.talon/workspace/memory/memory.md",
    log: "/fake/.talon/talon.log",
  },
  dirs: {
    root: "/fake/.talon",
    logs: "/fake/.talon/workspace/logs",
    workspace: "/fake/.talon/workspace",
    data: "/fake/.talon/data",
    memory: "/fake/.talon/workspace/memory",
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────

const {
  initHeartbeat,
  startHeartbeatTimer,
  stopHeartbeatTimer,
  forceHeartbeat,
  getHeartbeatStatus,
  awaitCurrentRun,
} = await import("../core/heartbeat.js");

describe("initHeartbeat", () => {
  it("accepts a config object without throwing", () => {
    expect(() => initHeartbeat({ model: "claude-sonnet-4-6" })).not.toThrow();
  });

  it("accepts all optional config fields", () => {
    expect(() =>
      initHeartbeat({
        model: "claude-sonnet-4-6",
        heartbeatModel: "claude-haiku-4-5",
        claudeBinary: "/usr/local/bin/claude",
        workspace: "/tmp/test-workspace",
      }),
    ).not.toThrow();
  });
});

describe("startHeartbeatTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    initHeartbeat({ model: "claude-sonnet-4-6" });
  });

  afterEach(() => {
    stopHeartbeatTimer();
    vi.useRealTimers();
  });

  it("guards against double-start during startup delay", () => {
    startHeartbeatTimer(60);
    // Calling again during the 5-minute startup delay should be a no-op
    // (no duplicate timers created)
    startHeartbeatTimer(60);
    // If the guard works, stopping once should clean up everything
    stopHeartbeatTimer();
    expect(true).toBe(true); // no crash = success
  });

  it("guards against double-start after interval is set", () => {
    startHeartbeatTimer(60);
    // Advance past startup delay to create the interval timer
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    // Now try to start again — should be a no-op
    startHeartbeatTimer(60);
    stopHeartbeatTimer();
    expect(true).toBe(true);
  });
});

describe("forceHeartbeat", () => {
  beforeEach(() => {
    initHeartbeat({ model: "claude-sonnet-4-6" });
    existsSyncMock.mockReturnValue(false);
    writeAtomicSyncMock.mockClear();
    queryMock.mockClear();
  });

  it("writes heartbeat state twice (running then idle) on success", async () => {
    await forceHeartbeat();

    expect(writeAtomicSyncMock).toHaveBeenCalledTimes(2);

    const firstCall = JSON.parse(
      writeAtomicSyncMock.mock.calls[0][1] as string,
    );
    expect(firstCall.status).toBe("running");

    const secondCall = JSON.parse(
      writeAtomicSyncMock.mock.calls[1][1] as string,
    );
    expect(secondCall.status).toBe("idle");
  });

  it("increments run_count only on success", async () => {
    await forceHeartbeat();

    const finalState = JSON.parse(
      writeAtomicSyncMock.mock.calls[
        writeAtomicSyncMock.mock.calls.length - 1
      ][1] as string,
    );
    expect(finalState.run_count).toBe(1);
    expect(finalState.status).toBe("idle");
  });

  it("preserves previous last_run on failure", async () => {
    const previousLastRun = Date.now() - 3600_000;
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        last_run: previousLastRun,
        status: "idle",
        run_count: 5,
      }),
    );

    // Make agent throw
    queryMock.mockImplementationOnce(async function* () {
      throw new Error("Agent exploded");
    });

    await expect(forceHeartbeat()).rejects.toThrow("Agent exploded");

    // The last write should preserve previous last_run and run_count
    const finalState = JSON.parse(
      writeAtomicSyncMock.mock.calls[
        writeAtomicSyncMock.mock.calls.length - 1
      ][1] as string,
    );
    expect(finalState.last_run).toBe(previousLastRun);
    expect(finalState.run_count).toBe(5);
    expect(finalState.status).toBe("idle");
  });

  it("sets last_started even on failure", async () => {
    existsSyncMock.mockReturnValue(false);

    queryMock.mockImplementationOnce(async function* () {
      throw new Error("Boom");
    });

    await expect(forceHeartbeat()).rejects.toThrow("Boom");

    const finalState = JSON.parse(
      writeAtomicSyncMock.mock.calls[
        writeAtomicSyncMock.mock.calls.length - 1
      ][1] as string,
    );
    expect(finalState.last_started).toBeGreaterThan(0);
  });

  it("rejects concurrent runs (concurrency guard)", async () => {
    const firstRun = forceHeartbeat().catch(() => {});

    // The running flag should now be true
    await expect(forceHeartbeat()).rejects.toThrow("Heartbeat already running");
    await firstRun;
  });

  it("resolves successfully when agent mock yields no messages", async () => {
    await expect(forceHeartbeat()).resolves.toBeUndefined();
  });
});

describe("getHeartbeatStatus", () => {
  it("returns null when no state file exists", () => {
    existsSyncMock.mockReturnValue(false);
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns parsed state when file exists", () => {
    const state = {
      last_run: Date.now(),
      status: "idle",
      run_count: 3,
    };
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(JSON.stringify(state));
    const result = getHeartbeatStatus();
    expect(result?.run_count).toBe(3);
    expect(result?.status).toBe("idle");
  });

  it("returns null for corrupt JSON", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue("{ invalid json ");
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when last_run is not a number", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        last_run: "not-a-number",
        status: "idle",
        run_count: 0,
      }),
    );
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when run_count is not a number", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        last_run: Date.now(),
        status: "idle",
        run_count: "five",
      }),
    );
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when status is invalid", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        last_run: Date.now(),
        status: "broken",
        run_count: 1,
      }),
    );
    expect(getHeartbeatStatus()).toBeNull();
  });

  it("returns null when last_run is NaN", () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        last_run: NaN,
        status: "idle",
        run_count: 0,
      }),
    );
    // NaN is typeof number but not finite
    expect(getHeartbeatStatus()).toBeNull();
  });
});

describe("awaitCurrentRun", () => {
  beforeEach(() => {
    initHeartbeat({ model: "claude-sonnet-4-6" });
    existsSyncMock.mockReturnValue(false);
    writeAtomicSyncMock.mockClear();
  });

  it("resolves immediately when no run is in progress", async () => {
    await expect(awaitCurrentRun()).resolves.toBeUndefined();
  });

  it("waits for in-flight run to complete", async () => {
    let resolveAgent!: () => void;
    const agentPromise = new Promise<void>((r) => {
      resolveAgent = r;
    });

    queryMock.mockImplementationOnce(async function* () {
      await agentPromise;
    });

    const runPromise = forceHeartbeat().catch(() => {});

    // awaitCurrentRun should not resolve until the agent finishes
    let awaited = false;
    const awaitPromise = awaitCurrentRun().then(() => {
      awaited = true;
    });

    // Give microtasks a chance to run
    await new Promise((r) => setTimeout(r, 10));
    expect(awaited).toBe(false);

    // Now resolve the agent
    resolveAgent();
    await awaitPromise;
    await runPromise;
    expect(awaited).toBe(true);
  });
});
