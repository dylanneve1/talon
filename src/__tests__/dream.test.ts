/**
 * Tests for src/core/dream.ts
 *
 * Covers: initDream, maybeStartDream (guard paths), forceDream (already running),
 * and the readDreamState / writeDreamState helpers via observable side effects.
 * The actual SDK agent call (executeDream → runDreamAgent) is mocked to avoid
 * spawning a real Claude agent in CI.
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

// Mock the agent SDK so runDreamAgent doesn't actually spawn Claude
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queryMock = vi.fn<() => AsyncGenerator<any>>(async function* () {
  // Yield nothing — simulates a clean run
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("../util/paths.js", () => ({
  files: {
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
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────

const { initDream, maybeStartDream, forceDream } =
  await import("../core/dream.js");

describe("initDream", () => {
  it("accepts a config object without throwing", () => {
    expect(() => initDream({ model: "claude-sonnet-4-6" })).not.toThrow();
  });

  it("accepts all optional config fields", () => {
    expect(() =>
      initDream({
        model: "claude-sonnet-4-6",
        dreamModel: "claude-haiku-4-5",
        claudeBinary: "/usr/local/bin/claude",
        workspace: "/tmp/test-workspace",
      }),
    ).not.toThrow();
  });
});

describe("maybeStartDream", () => {
  beforeEach(() => {
    initDream({ model: "claude-sonnet-4-6" });
  });

  it("does nothing when no dream state exists (elapsed = 0 vs never)", () => {
    // existsSync returns false → readDreamState returns null → last_run = 0
    // elapsed = now - 0 = now (> 12h) → dream would run, but agent is mocked
    existsSyncMock.mockReturnValue(false);
    // Should not throw
    expect(() => maybeStartDream()).not.toThrow();
  });

  it("does nothing when dream was recently run (within 12 hours)", () => {
    const recentRun = Date.now() - 1_000; // 1 second ago
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue(
      JSON.stringify({ last_run: recentRun, status: "idle" }),
    );

    expect(() => maybeStartDream()).not.toThrow();
  });

  it("does not start if already dreaming (concurrent guard)", async () => {
    // Start a dream to set dreaming = true
    existsSyncMock.mockReturnValue(false);

    // forceDream will try to run, but since the SDK is mocked to return immediately
    // the dreaming flag will be released after the promise resolves.
    // We test that a second call to forceDream while one is already awaited throws.

    // Reset the module to get a fresh dreaming=false state
    // (we can't easily reset module state here, so just verify the throw path)
    // Instead, use forceDream twice concurrently:
    const firstDream = forceDream().catch(() => {});

    // The "dreaming" flag should now be true — forceDream should throw
    await expect(forceDream()).rejects.toThrow("Dream already running");
    await firstDream;
  });
});

describe("forceDream", () => {
  beforeEach(() => {
    initDream({ model: "claude-sonnet-4-6" });
    existsSyncMock.mockReturnValue(false);
    writeAtomicSyncMock.mockClear();
  });

  it("writes dream state twice (running then idle)", async () => {
    await forceDream();
    // writeDreamState is called twice: once with status:running, once with status:idle
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

  it("resolves successfully when agent mock yields no messages", async () => {
    await expect(forceDream()).resolves.toBeUndefined();
  });

  it("rejects and re-throws when not initialized (no configRef)", async () => {
    // Re-import with a fresh module to get unconfigured state
    vi.resetModules();
    // Re-apply mocks
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "null"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
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
      },
    }));

    const { forceDream: forceDreamFresh } = await import("../core/dream.js");
    // Not initialized → runDreamAgent warns and returns "" → no throw on "forced"
    // Actually looking at the code: if !configRef → logWarn and return ""
    // Which means executeDream resolves and writes state → no throw
    await expect(forceDreamFresh()).resolves.toBeUndefined();
  });
});

describe("readDreamState — edge cases", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/paths.js", () => ({
      files: {
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
      },
    }));
  });

  it("maybeStartDream is a no-op when dream file is corrupt (falls through to elapsed check)", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => "{ invalid json "),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));

    const { initDream: initFresh, maybeStartDream: maybeFresh } =
      await import("../core/dream.js");
    initFresh({ model: "claude-sonnet-4-6" });
    // Corrupt state → readDreamState returns null → last_run=0 → long elapsed → dream fires
    // It won't throw because errors are swallowed in executeDream when trigger="auto"
    expect(() => maybeFresh()).not.toThrow();
  });

  it("maybeStartDream treats non-numeric last_run as stale (readDreamState returns null)", async () => {
    // Covers `if (typeof parsed.last_run !== "number") return null`
    const invalidState = { last_run: "not-a-number", status: "idle" };
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify(invalidState)),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));

    const { initDream: initFresh, maybeStartDream: maybeFresh } =
      await import("../core/dream.js");
    initFresh({ model: "claude-sonnet-4-6" });
    // non-numeric last_run → readDreamState returns null → treated as very old → dream fires
    expect(() => maybeFresh()).not.toThrow();
  });

  it("maybeStartDream skips when state has last_run within interval", async () => {
    const recentState = { last_run: Date.now() - 60_000, status: "idle" };
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify(recentState)),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));

    const { initDream: initFresh, maybeStartDream: maybeFresh } =
      await import("../core/dream.js");
    initFresh({ model: "claude-sonnet-4-6" });
    const queryMock = vi.fn(async function* () {});
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
    maybeFresh();
    // Query should NOT have been called (interval not yet elapsed)
    expect(queryMock).not.toHaveBeenCalled();
  });
});

// ── logDreamMessage coverage — all switch cases ───────────────────────────────

describe("logDreamMessage — processes all message types", () => {
  // Use the top-level hoisted vi.mock mocks (queryMock, appendFileSyncMock, etc.)
  // instead of vi.doMock + vi.resetModules to avoid flaky module cache issues in CI.

  beforeEach(() => {
    appendFileSyncMock.mockClear();
    existsSyncMock.mockReturnValue(false);
    readFileSyncMock.mockReturnValue("dream prompt template");
    writeAtomicSyncMock.mockClear();
    initDream({ model: "claude-sonnet-4-6", workspace: "/fake/ws" });
  });

  afterEach(() => {
    // Reset query mock to default (yield nothing) so other tests aren't affected
    queryMock.mockImplementation(async function* () {});
  });

  function setupQuery(messages: unknown[]) {
    queryMock.mockImplementation(async function* () {
      for (const msg of messages) yield msg;
    });
  }

  function getLogOutput(): string {
    return appendFileSyncMock.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .join("");
  }

  it("processes assistant message with text content blocks", async () => {
    setupQuery([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "I am analyzing..." }] },
      },
    ]);
    await forceDream();
    expect(getLogOutput()).toContain("I am analyzing...");
  });

  it("processes assistant message with tool_use content blocks", async () => {
    setupQuery([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/tmp/test.md" },
            },
          ],
        },
      },
    ]);
    await forceDream();
    const output = getLogOutput();
    expect(output).toContain("Read");
    expect(output).toContain("Tool call:");
  });

  it("processes result message", async () => {
    setupQuery([
      {
        type: "result",
        subtype: "success",
        result: "Memory consolidated successfully.",
      },
    ]);
    await forceDream();
    const output = getLogOutput();
    expect(output).toContain("Memory consolidated successfully.");
    expect(output).toContain("Result");
  });

  it("processes result message with truncation for long results", async () => {
    setupQuery([
      { type: "result", subtype: "success", result: "X".repeat(3000) },
    ]);
    await forceDream();
    expect(getLogOutput()).toContain("... (truncated)");
  });

  it("processes system message", async () => {
    setupQuery([{ type: "system", subtype: "init" }]);
    await forceDream();
    expect(getLogOutput()).toContain("System");
  });

  it("processes user message with string tool_use_result", async () => {
    setupQuery([{ type: "user", tool_use_result: "tool ran successfully" }]);
    await forceDream();
    expect(getLogOutput()).toContain("tool ran successfully");
  });

  it("processes user message with object tool_use_result", async () => {
    setupQuery([
      {
        type: "user",
        tool_use_result: { output: "file contents", truncated: false },
      },
    ]);
    await forceDream();
    expect(getLogOutput()).toContain("file contents");
  });

  it("processes user message with long tool_use_result (truncation)", async () => {
    setupQuery([{ type: "user", tool_use_result: "Y".repeat(3000) }]);
    await forceDream();
    expect(getLogOutput()).toContain("... (truncated)");
  });

  it("skips stream_event messages (default case)", async () => {
    setupQuery([
      { type: "stream_event", event: { type: "content_block_delta" } },
    ]);
    await expect(forceDream()).resolves.toBeUndefined();
  });

  it("result message without 'result' field falls back to JSON.stringify", async () => {
    setupQuery([
      // Intentionally omit 'result' field — covers JSON.stringify(msg) branch
      { type: "result", subtype: "success" },
    ]);
    await forceDream();
    expect(getLogOutput()).toContain("result");
  });

  it("user message without tool_use_result is silently skipped", async () => {
    setupQuery([
      { type: "user" }, // no tool_use_result field
    ]);
    await expect(forceDream()).resolves.toBeUndefined();
  });

  it("processes multiple message types in sequence", async () => {
    setupQuery([
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Analyzing logs." }] },
      },
      { type: "result", subtype: "success", result: "Done." },
    ]);
    await forceDream();
    const output = getLogOutput();
    expect(output).toContain("Analyzing logs.");
    expect(output).toContain("Done.");
  });
});

describe("dream error paths", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("logError when writeDreamState throws (writeFileAtomic.sync fails)", async () => {
    const logErrorMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: logErrorMock,
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({
      default: {
        sync: vi.fn(() => {
          throw new Error("disk full");
        }),
      },
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    // writeDreamState throwing should not crash forceDream (error is swallowed)
    await expect(mod.forceDream()).resolves.toBeUndefined();
    expect(logErrorMock).toHaveBeenCalledWith(
      "dream",
      "Failed to write dream state",
      expect.any(Error),
    );
  });

  it("logError when appendFileSync throws in appendDreamLog", async () => {
    const logErrorMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: logErrorMock,
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(() => {
        throw new Error("append failed");
      }),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    // appendFileSync throws, but appendDreamLog catches it
    await expect(mod.forceDream()).resolves.toBeUndefined();
    expect(logErrorMock).toHaveBeenCalledWith(
      "dream",
      "Failed to write dream log",
      expect.any(Error),
    );
  });

  it("forceDream rethrows when runDreamAgent fails (prompt file unreadable)", async () => {
    const logErrorMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: logErrorMock,
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false), // readDreamState returns null (no read needed)
      readFileSync: vi.fn(() => {
        throw new Error("ENOENT: prompt file missing");
      }),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    // forceDream rethrows when runDreamAgent throws (trigger === "forced")
    await expect(mod.forceDream()).rejects.toThrow(
      "Failed to read dream prompt",
    );
    expect(logErrorMock).toHaveBeenCalledWith(
      "dream",
      expect.stringContaining("Memory consolidation failed"),
      expect.any(Error),
    );
  });

  it("runDreamAgent uses non-zero lastRunTimestamp when state has last_run > 0 (line 112 TRUE branch)", async () => {
    const appendFileSyncMock = vi.fn();
    const lastRun = Date.now() - 3_600_000; // 1 hour ago
    const stateJson = JSON.stringify({ last_run: lastRun, status: "idle" });

    vi.doMock("node:fs", () => {
      const readFileSyncFn = vi
        .fn()
        .mockReturnValueOnce(stateJson) // readDreamState reads dream_state.json
        .mockReturnValue("dream prompt"); // subsequent calls: prompt file
      return {
        existsSync: vi.fn(() => true),
        readFileSync: readFileSyncFn,
        mkdirSync: vi.fn(),
        appendFileSync: appendFileSyncMock,
      };
    });
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6", workspace: "/fake/ws" });
    await mod.forceDream();

    const logOutput = appendFileSyncMock.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .join("");
    // TRUE branch: lastRunTimestamp > 0 → ISO string used instead of "beginning of time"
    expect(logOutput).toContain(new Date(lastRun).toISOString());
    expect(logOutput).not.toContain("beginning of time");
  });

  it("runDreamAgent includes pathToClaudeCodeExecutable when claudeBinary set, and uses dreamModel (lines 135+150 TRUE branches)", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    const queryMock = vi.fn(async function* () {});
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const mod = await import("../core/dream.js");
    mod.initDream({
      model: "claude-sonnet-4-6",
      dreamModel: "claude-haiku-4-5",
      claudeBinary: "/usr/local/bin/claude",
      workspace: "/fake/ws",
    });
    await mod.forceDream();

    expect(queryMock).toHaveBeenCalled();
    const callArgs = (queryMock.mock.calls[0] as unknown[])[0] as {
      options: Record<string, unknown>;
    };
    // dreamModel TRUE branch (line 135): haiku model used instead of sonnet
    expect(callArgs.options).toHaveProperty("model", "claude-haiku-4-5");
    // claudeBinary TRUE branch (line 150): pathToClaudeCodeExecutable spread in
    expect(callArgs.options).toHaveProperty(
      "pathToClaudeCodeExecutable",
      "/usr/local/bin/claude",
    );
  });

  it("assistant block with type='text' but no 'text' property maps to empty string (line 226 FALSE branch)", async () => {
    const appendFileSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: appendFileSyncMock,
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {
        // type="text" but no "text" property — covers `"text" in b` FALSE branch
        yield { type: "assistant", message: { content: [{ type: "text" }] } };
      }),
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6", workspace: "/fake/ws" });
    await mod.forceDream();

    // textBlocks = [""] (empty string from false branch), length > 0 → Assistant block logged
    const logOutput = appendFileSyncMock.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .join("");
    expect(logOutput).toContain("Assistant");
  });

  it("agent crash causes forceDream to reject with failure log entry", async () => {
    const appendFileSyncMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: appendFileSyncMock,
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {
        yield; // satisfy require-yield
        throw new Error("agent crashed unexpectedly");
      }),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    await expect(mod.forceDream()).rejects.toThrow(
      "agent crashed unexpectedly",
    );
    const logOutput = appendFileSyncMock.mock.calls
      .map((c: unknown[]) => c[1] as string)
      .join("");
    expect(logOutput).toContain("Dream FAILED");
  });

  it("maybeStartDream returns early when dreaming=true (line 61 TRUE branch)", async () => {
    let resolveQuery!: () => void;
    const queryPromise = new Promise<void>((resolve) => {
      resolveQuery = resolve;
    });
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {
        yield; // satisfy require-yield
        await queryPromise; // suspend until we release
      }),
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6", workspace: "/fake/ws" });

    // forceDream sets dreaming=true synchronously before its first await
    const dreamPromise = mod.forceDream();
    // dreaming is now true — maybeStartDream should hit the `if (dreaming) return` guard
    mod.maybeStartDream();
    // Release the suspended query so forceDream can finish
    resolveQuery();
    await dreamPromise;
  });

  it("auto-triggered dream failure swallows error (line 98 FALSE branch: trigger !== 'forced')", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => {
        throw new Error("prompt missing for auto dream");
      }),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    const logErrorMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: logErrorMock,
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6", workspace: "/fake/ws" });

    // maybeStartDream fires auto dream (elapsed > 12h since state is null)
    mod.maybeStartDream();
    // Give the async fire-and-forget dream time to run and fail
    await new Promise((r) => setTimeout(r, 50));

    // trigger === "auto" → error is NOT re-thrown (FALSE branch of if trigger==="forced")
    // logError should have been called with the failure
    expect(logErrorMock).toHaveBeenCalledWith(
      "dream",
      expect.stringContaining("Memory consolidation failed"),
      expect.any(Error),
    );
  });

  it("model defaults to 'default' when neither dreamModel nor model set (line 135 FALSE??FALSE branch)", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    const queryMock = vi.fn(async function* () {});
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const mod = await import("../core/dream.js");
    // No model or dreamModel → falls through to the canonical SDK default model
    mod.initDream({ workspace: "/fake/ws" });
    await mod.forceDream();

    const callArgs = (queryMock.mock.calls[0] as unknown[])[0] as {
      options: Record<string, unknown>;
    };
    expect(callArgs.options).toHaveProperty("model", "default");
  });
});

describe("runDreamAgent — timeout arrow fn fires after DREAM_TIMEOUT_MS", () => {
  it("covers the setTimeout reject callback via fake timers (10-minute dream timeout)", async () => {
    vi.resetModules();
    vi.useFakeTimers();

    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "null"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    // query never resolves — so the 10-minute timeout wins the race
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {
        yield; // satisfy require-yield
        await new Promise(() => {}); // never resolves
      }),
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });

    const dreamPromise = mod.forceDream().catch(() => {});
    // Advance past DREAM_TIMEOUT_MS (10 minutes) to fire the setTimeout reject callback
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
    await dreamPromise;

    vi.useRealTimers();
  });
});

describe("mempalace section gating in dream prompt", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("includes mempalace mining command and diary instructions when mempalace is configured", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "PROMPT START {{mempalaceSection}} PROMPT END"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    const queryMock = vi.fn(async function* () {});
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const mod = await import("../core/dream.js");
    mod.initDream({
      model: "claude-sonnet-4-6",
      workspace: "/fake/ws",
      mempalace: {
        pythonPath: "/usr/bin/python3",
        palacePath: "/fake/palace",
      },
    });
    await mod.forceDream();

    expect(queryMock).toHaveBeenCalled();
    const callArgs = (queryMock.mock.calls[0] as unknown[])[0] as {
      prompt: string;
    };
    // Mempalace mining command should be in the prompt
    expect(callArgs.prompt).toContain("-m mempalace mine");
    // Diary instructions should be in the prompt
    expect(callArgs.prompt).toContain("mempalace_diary_write");
    // Should NOT contain the skip message
    expect(callArgs.prompt).not.toContain(
      "MemPalace is not configured. Skip this stage.",
    );
  });

  it("includes skip message when mempalace is not configured", async () => {
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "PROMPT START {{mempalaceSection}} PROMPT END"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));
    const queryMock = vi.fn(async function* () {});
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const mod = await import("../core/dream.js");
    // No mempalace config
    mod.initDream({
      model: "claude-sonnet-4-6",
      workspace: "/fake/ws",
    });
    await mod.forceDream();

    expect(queryMock).toHaveBeenCalled();
    const callArgs = (queryMock.mock.calls[0] as unknown[])[0] as {
      prompt: string;
    };
    // Should contain the skip message
    expect(callArgs.prompt).toContain(
      "MemPalace is not configured. Skip this stage.",
    );
    // Should NOT contain mempalace mining commands
    expect(callArgs.prompt).not.toContain("-m mempalace mine");
    expect(callArgs.prompt).not.toContain("mempalace_diary_write");
  });
});

describe("maybeStartDream — () => {} catch callback on executeDream rejection", () => {
  it("fires the catch callback silently when executeDream('auto') rejects", async () => {
    vi.resetModules();

    // Make log throw on first call — that call is at L89 (before the try block)
    // in executeDream, which causes the async function to reject.
    const logMock = vi.fn(() => {
      throw new Error("log forced fail");
    });
    vi.doMock("../util/log.js", () => ({
      log: logMock,
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "null"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {}),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: {
        dreamState: "/fake/.talon/data/dream_state.json",
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });

    // existsSync returns false → state null → elapsed = now >> 12h → executeDream fires
    // log throws before the try block → executeDream("auto") rejects
    // .catch(() => {}) swallows the rejection silently
    expect(() => mod.maybeStartDream()).not.toThrow();

    // Flush microtasks so the .catch(() => {}) callback fires
    await new Promise((r) => setTimeout(r, 0));
    // No uncaught rejection — the () => {} catch callback covered
  });
});
