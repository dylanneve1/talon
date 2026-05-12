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

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

const appendFileMock = vi.fn(async () => {});
const mkdirAsyncMock = vi.fn(async () => undefined);
vi.mock("node:fs/promises", () => ({
  appendFile: appendFileMock,
  mkdir: mkdirAsyncMock,
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

vi.mock("../core/plugin.js", () => ({
  getPluginMcpServers: vi.fn(() => ({})),
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
    dailyMemory: "/fake/.talon/workspace/memory/daily",
    prompts: "/fake/.talon/prompts",
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
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    startHeartbeatTimer(60);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // Calling again during the 5-minute startup delay should be a no-op
    startHeartbeatTimer(60);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

  it("guards against double-start after interval is set", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    startHeartbeatTimer(60);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    // Advance past startup delay to create the interval timer
    vi.advanceTimersByTime(5 * 60 * 1000 + 100);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    // Now try to start again — should be a no-op (interval count stays at 1)
    startHeartbeatTimer(60);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });
});

describe("forceHeartbeat", () => {
  beforeEach(() => {
    initHeartbeat({ model: "claude-sonnet-4-6" });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md"))
        return "heartbeat prompt {{workspace}} {{logsDir}} {{lastRunIso}} {{memoryFile}} {{instructionsFile}} {{runCount}} {{intervalMinutes}}";
      return "null";
    }) as any);
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

  it("passes plugin MCP servers to the agent via getPluginMcpServers", async () => {
    const { getPluginMcpServers } = await import("../core/plugin.js");
    const mockServers = {
      "email-tools": { command: "node", args: ["email.js"], env: {} },
    };
    vi.mocked(getPluginMcpServers).mockReturnValue(mockServers);

    await forceHeartbeat();

    expect(getPluginMcpServers).toHaveBeenCalledWith("", "heartbeat");
    // Verify mcpServers was passed through to query()
    const queryCall = queryMock.mock.calls[0] as unknown as [
      { options: { mcpServers: Record<string, unknown> } },
    ];
    expect(queryCall[0].options.mcpServers).toEqual(mockServers);
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
      yield; // satisfy require-yield
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
      yield; // satisfy require-yield
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

  it("passes an AbortController to the SDK query() options", async () => {
    await forceHeartbeat();

    const queryCall = queryMock.mock.calls[0] as unknown as [
      { options: { abortController?: AbortController } },
    ];
    const ac = queryCall[0].options.abortController;
    expect(ac).toBeInstanceOf(AbortController);
    expect(ac?.signal.aborted).toBe(false);
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

  it("returns null when last_run is non-finite", () => {
    existsSyncMock.mockReturnValue(true);
    // 1e309 parses to Infinity, which is typeof number but not finite
    readFileSyncMock.mockReturnValue(
      '{"last_run":1e309,"status":"idle","run_count":0}',
    );
    expect(getHeartbeatStatus()).toBeNull();
  });
});

describe("buildHeartbeatSystemPrompt", () => {
  // Snapshot the SDK-backend mock so we can swap getActiveFrontends per case.
  // The default mock at the top of the file doesn't include it; we re-mock
  // here for the prompt-shape tests specifically.
  let getActiveFrontendsMock: ReturnType<typeof vi.fn>;
  let mod: typeof import("../core/heartbeat.js");

  beforeEach(async () => {
    vi.resetModules();
    getActiveFrontendsMock = vi.fn(() => []);
    vi.doMock("../backend/claude-sdk/index.js", () => ({
      buildMcpServers: vi.fn(() => ({})),
      getActiveFrontends: getActiveFrontendsMock,
    }));
    // Carry through the other mocks the module needs at import time.
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../core/plugin.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("../util/paths.js", () => ({
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
        dailyMemory: "/fake/.talon/workspace/memory/daily",
        prompts: "/fake/.talon/prompts",
      },
    }));
    mod = await import("../core/heartbeat.js");
  });

  afterEach(() => {
    vi.doUnmock("../backend/claude-sdk/index.js");
    vi.doUnmock("../util/log.js");
    vi.doUnmock("../core/plugin.js");
    vi.doUnmock("../util/paths.js");
  });

  it("returns base prompt without outbound section when no frontends are configured", () => {
    getActiveFrontendsMock.mockReturnValueOnce([]);
    const prompt = mod.buildHeartbeatSystemPrompt();
    expect(prompt).toContain("background heartbeat agent");
    expect(prompt).not.toContain("OUTBOUND MESSAGING");
    expect(prompt).not.toContain("telegram-tools");
  });

  it("returns base prompt without outbound section when config init throws", () => {
    getActiveFrontendsMock.mockImplementationOnce(() => {
      throw new Error("config not initialised");
    });
    const prompt = mod.buildHeartbeatSystemPrompt();
    expect(prompt).toContain("background heartbeat agent");
    expect(prompt).not.toContain("OUTBOUND MESSAGING");
  });

  it("references telegram-tools when telegram is the only frontend", () => {
    getActiveFrontendsMock.mockReturnValueOnce(["telegram"]);
    const prompt = mod.buildHeartbeatSystemPrompt();
    expect(prompt).toContain("OUTBOUND MESSAGING");
    expect(prompt).toContain("`telegram-tools`");
    expect(prompt).not.toContain("`teams-tools`");
  });

  it("references teams-tools when teams is the only frontend", () => {
    getActiveFrontendsMock.mockReturnValueOnce(["teams"]);
    const prompt = mod.buildHeartbeatSystemPrompt();
    expect(prompt).toContain("OUTBOUND MESSAGING");
    expect(prompt).toContain("`teams-tools`");
    expect(prompt).not.toContain("`telegram-tools`");
  });

  it("lists ALL active frontends when multiple are configured", () => {
    getActiveFrontendsMock.mockReturnValueOnce(["telegram", "teams"]);
    const prompt = mod.buildHeartbeatSystemPrompt();
    expect(prompt).toContain("OUTBOUND MESSAGING");
    expect(prompt).toContain("`telegram-tools`");
    expect(prompt).toContain("`teams-tools`");
  });

  it("uses the first frontend in the example send() call", () => {
    getActiveFrontendsMock.mockReturnValueOnce(["teams", "telegram"]);
    const prompt = mod.buildHeartbeatSystemPrompt();
    // `teams-tools` is first → it appears in the "from `teams-tools`" example
    expect(prompt).toMatch(/from `teams-tools`/);
  });

  it("does not mention chat-id parameter when there are no frontends", () => {
    getActiveFrontendsMock.mockReturnValueOnce([]);
    const prompt = mod.buildHeartbeatSystemPrompt();
    expect(prompt).not.toContain("chat_id");
  });
});

describe("awaitCurrentRun", () => {
  beforeEach(() => {
    initHeartbeat({ model: "claude-sonnet-4-6" });
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncMock.mockImplementation(((filePath: string) => {
      const p = String(filePath).replace(/\\/g, "/");
      if (p.endsWith("/heartbeat.md"))
        return "heartbeat prompt {{workspace}} {{logsDir}} {{lastRunIso}} {{memoryFile}} {{instructionsFile}} {{runCount}} {{intervalMinutes}}";
      return "null";
    }) as any);
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
      yield; // satisfy require-yield
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

// ── Eviction tests ────────────────────────────────────────────────────────
//
// These cover the fix for the wedged-heartbeat bug: when the SDK subprocess
// hangs and ignores AbortController.abort(), the heartbeat must still
// release its lock so the next interval can fire. Prior behaviour was to
// `await agentPromise.catch(() => {})` indefinitely, which deadlocked the
// lock for as long as the SDK was hung (in prod: 17+ hours on 2026-05-10).

describe("heartbeat eviction (timeout + abort + orphan sweep)", () => {
  let mod: typeof import("../core/heartbeat.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let evictionQueryMock: any;

  beforeEach(async () => {
    // Re-import the module with small timeouts so tests don't wait minutes.
    process.env.TALON_HEARTBEAT_TIMEOUT_MS = "50";
    process.env.TALON_HEARTBEAT_ABORT_GRACE_MS = "50";
    process.env.TALON_HEARTBEAT_SUBPROCESS_KILL_GRACE_MS = "10";
    vi.resetModules();

    // Re-mock everything for the fresh module graph.
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: () => false,
      readFileSync: (filePath: string) => {
        const p = String(filePath).replace(/\\/g, "/");
        if (p.endsWith("/heartbeat.md"))
          return "heartbeat prompt {{workspace}} {{logsDir}} {{lastRunIso}} {{memoryFile}} {{instructionsFile}} {{runCount}} {{intervalMinutes}}";
        return "null";
      },
      mkdirSync: vi.fn(),
    }));
    vi.doMock("node:fs/promises", () => ({
      appendFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => undefined),
      // Force readdir to return empty so the orphan sweep finds nothing.
      readdir: vi.fn(async () => []),
      readFile: vi.fn(async () => ""),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    evictionQueryMock = vi.fn<() => AsyncGenerator<any>>();
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: evictionQueryMock,
    }));
    vi.doMock("../core/plugin.js", () => ({
      getPluginMcpServers: vi.fn(() => ({})),
    }));
    vi.doMock("../util/paths.js", () => ({
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
        dailyMemory: "/fake/.talon/workspace/memory/daily",
        prompts: "/fake/.talon/prompts",
      },
    }));

    mod = await import("../core/heartbeat.js");
    mod.initHeartbeat({ model: "claude-sonnet-4-6" });
  });

  afterEach(() => {
    delete process.env.TALON_HEARTBEAT_TIMEOUT_MS;
    delete process.env.TALON_HEARTBEAT_ABORT_GRACE_MS;
    delete process.env.TALON_HEARTBEAT_SUBPROCESS_KILL_GRACE_MS;
    vi.doUnmock("../util/log.js");
    vi.doUnmock("node:fs");
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("write-file-atomic");
    vi.doUnmock("@anthropic-ai/claude-agent-sdk");
    vi.doUnmock("../core/plugin.js");
    vi.doUnmock("../util/paths.js");
  });

  it("calls AbortController.abort() when the agent hangs past the timeout", async () => {
    let capturedSignal: AbortSignal | undefined;
    evictionQueryMock.mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (args: any) => {
        capturedSignal = args.options.abortController?.signal;
        // Hang: an async generator that yields forever but resolves cleanly
        // when its signal aborts.
        // eslint-disable-next-line require-yield
        return (async function* () {
          await new Promise<void>((resolve) => {
            const onAbort = () => resolve();
            capturedSignal?.addEventListener("abort", onAbort, { once: true });
          });
          // After abort, throw to mimic the SDK's behaviour.
          throw new Error("aborted");
        })();
      },
    );

    await expect(mod.forceHeartbeat()).rejects.toThrow(
      "Heartbeat agent timed out",
    );

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("releases the running lock even when the SDK ignores abort", async () => {
    // Pathological SDK: never settles even after abort is signalled. This is
    // the exact prod failure mode from 2026-05-10.
    evictionQueryMock.mockImplementationOnce(() => {
      return (async function* () {
        // Never yields, never throws — wait on a promise that's never resolved.
        await new Promise<void>(() => {
          /* unresolved */
        });
        // eslint-disable-next-line @typescript-eslint/no-unreachable
        yield undefined;
      })();
    });

    await expect(mod.forceHeartbeat()).rejects.toThrow(
      "Heartbeat agent timed out",
    );

    // The critical property: a second heartbeat must NOT be rejected with
    // "Heartbeat already running" — the lock must have been released.
    // Use a clean-yielding mock for the second call so the test stays bounded.
    evictionQueryMock.mockImplementationOnce(async function* () {
      // No yields == clean exit
    });
    await expect(mod.forceHeartbeat()).resolves.toBeUndefined();
  }, 5000);

  it("evictOrphanHeartbeatSubprocesses is a no-op on non-Linux platforms", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });

    try {
      const result = await mod.evictOrphanHeartbeatSubprocesses();
      expect(result).toEqual({ found: 0, termed: 0, killed: 0 });
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });

  it("evictOrphanHeartbeatSubprocesses scans /proc and identifies heartbeat-marked subprocesses on Linux", async () => {
    // Override the mocked node:fs/promises specifically for this test
    vi.doMock("node:fs/promises", () => ({
      appendFile: vi.fn(async () => {}),
      mkdir: vi.fn(async () => undefined),
      readdir: vi.fn(async () => ["1", "2", "3", "999", "self", "thread"]),
      // PIDs 1 and 999 are heartbeat-marked; 2 isn't; 3 is the regression
      // case — an unrelated env var whose VALUE contains the marker substring
      // (the old `includes(...)` check would false-positive and SIGKILL it).
      // thread errors.
      readFile: vi.fn(async (path: string) => {
        if (path === "/proc/1/environ")
          return "TALON_CHAT_ID=heartbeat\0OTHER=x";
        if (path === "/proc/2/environ") return "TALON_CHAT_ID=foo\0OTHER=x";
        if (path === "/proc/3/environ")
          return "OTHER_VAR=TALON_CHAT_ID=heartbeat\0FOO=bar";
        if (path === "/proc/999/environ")
          return "FOO=bar\0TALON_CHAT_ID=heartbeat";
        throw new Error("ESRCH");
      }),
    }));
    vi.resetModules();
    // Re-trigger initHeartbeat against the freshly remocked graph
    const { initHeartbeat, evictOrphanHeartbeatSubprocesses } =
      await import("../core/heartbeat.js");
    initHeartbeat({ model: "claude-sonnet-4-6" });

    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });

    // Stub process.kill so we don't actually kill anything during the test.
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    // Make the signal-0 probe in the SIGKILL escalation branch throw ESRCH,
    // simulating "already exited after SIGTERM" so we don't count fake kills.
    killSpy.mockImplementation((pid: number, signal?: string | number) => {
      if (signal === 0) {
        const e = new Error("ESRCH") as Error & { code?: string };
        e.code = "ESRCH";
        throw e;
      }
      return true;
    });

    try {
      const result = await evictOrphanHeartbeatSubprocesses();
      // PIDs 1 and 999 should both be found (own pid excluded).
      // PID 3 has the marker only as a substring of another var's value —
      // must NOT be matched (regression test for false-positive SIGKILL).
      // We exclude our own pid, but neither 1, 3, nor 999 should match it.
      expect(result.found).toBe(2);
      expect(result.termed).toBe(2);
      // killed should be 0 because we made signal-0 throw ESRCH
      expect(result.killed).toBe(0);
      // Verify PID 3 specifically was never targeted (no SIGTERM, no signal-0
      // probe). If killSpy received any call for pid 3, the substring-vs-token
      // distinction has regressed.
      const pid3Calls = killSpy.mock.calls.filter((args) => args[0] === 3);
      expect(pid3Calls).toEqual([]);
    } finally {
      killSpy.mockRestore();
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
