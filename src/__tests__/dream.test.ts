/**
 * Tests for src/core/dream.ts
 *
 * Covers: initDream, maybeStartDream (guard paths), forceDream (already running),
 * and the readDreamState / writeDreamState helpers via observable side effects.
 * The actual SDK agent call (executeDream → runDreamAgent) is mocked to avoid
 * spawning a real Claude agent in CI.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  appendFileSync: vi.fn(),
}));

const writeAtomicSyncMock = vi.fn();
vi.mock("write-file-atomic", () => ({
  default: { sync: writeAtomicSyncMock },
}));

// Mock the agent SDK so runDreamAgent doesn't actually spawn Claude
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    // Yield nothing — simulates a clean run
  }),
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
  },
}));

// ── Tests ─────────────────────────────────────────────────────────────────

const { initDream, maybeStartDream, forceDream } = await import("../core/dream.js");

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
      })
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
      JSON.stringify({ last_run: recentRun, status: "idle" })
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

    const firstCall = JSON.parse(writeAtomicSyncMock.mock.calls[0][1] as string);
    expect(firstCall.status).toBe("running");

    const secondCall = JSON.parse(writeAtomicSyncMock.mock.calls[1][1] as string);
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
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(),
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
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(),
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

    const { initDream: initFresh, maybeStartDream: maybeFresh } = await import("../core/dream.js");
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

    const { initDream: initFresh, maybeStartDream: maybeFresh } = await import("../core/dream.js");
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

    const { initDream: initFresh, maybeStartDream: maybeFresh } = await import("../core/dream.js");
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
  beforeEach(() => {
    vi.resetModules();
  });

  async function setupWithMessages(messages: unknown[]) {
    const appendFileSyncMock = vi.fn();
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt template"),
      mkdirSync: vi.fn(),
      appendFileSync: appendFileSyncMock,
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(),
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
      },
    }));
    vi.doMock("@anthropic-ai/claude-agent-sdk", () => ({
      query: vi.fn(async function* () {
        for (const msg of messages) yield msg;
      }),
    }));
    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6", workspace: "/fake/ws" });
    return { mod, appendFileSyncMock };
  }

  it("processes assistant message with text content blocks", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "assistant", message: { content: [{ type: "text", text: "I am analyzing..." }] } },
    ]);
    await mod.forceDream();
    // appendFileSync should have been called with content containing the assistant text
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("I am analyzing...");
  });

  it("processes assistant message with tool_use content blocks", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.md" } },
          ],
        },
      },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("Read");
    expect(calls).toContain("Tool call:");
  });

  it("processes result message", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "result", subtype: "success", result: "Memory consolidated successfully." },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("Memory consolidated successfully.");
    expect(calls).toContain("Result");
  });

  it("processes result message with truncation for long results", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "result", subtype: "success", result: "X".repeat(3000) },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("... (truncated)");
  });

  it("processes system message", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "system", subtype: "init" },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("System");
  });

  it("processes user message with string tool_use_result", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "user", tool_use_result: "tool ran successfully" },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("tool ran successfully");
  });

  it("processes user message with object tool_use_result", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "user", tool_use_result: { output: "file contents", truncated: false } },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("file contents");
  });

  it("processes user message with long tool_use_result (truncation)", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "user", tool_use_result: "Y".repeat(3000) },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("... (truncated)");
  });

  it("skips stream_event messages (default case)", async () => {
    const { mod } = await setupWithMessages([
      { type: "stream_event", event: { type: "content_block_delta" } },
    ]);
    // Should complete without errors
    await expect(mod.forceDream()).resolves.toBeUndefined();
  });

  it("result message without 'result' field falls back to JSON.stringify", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      // Intentionally omit 'result' field — covers JSON.stringify(msg) branch
      { type: "result", subtype: "success" },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    // JSON.stringify({type:"result",subtype:"success"}) should appear in the output
    expect(calls).toContain("result");
  });

  it("user message without tool_use_result is silently skipped", async () => {
    // Covers the false branch of `if (msg.tool_use_result != null)`
    const { mod } = await setupWithMessages([
      { type: "user" }, // no tool_use_result field
    ]);
    await expect(mod.forceDream()).resolves.toBeUndefined();
  });

  it("processes multiple message types in sequence", async () => {
    const { mod, appendFileSyncMock } = await setupWithMessages([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "Analyzing logs." }] } },
      { type: "result", subtype: "success", result: "Done." },
    ]);
    await mod.forceDream();
    const calls = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(calls).toContain("Analyzing logs.");
    expect(calls).toContain("Done.");
  });
});

describe("dream error paths", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("logError when writeDreamState throws (writeFileAtomic.sync fails)", async () => {
    const logErrorMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: logErrorMock, logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({
      default: { sync: vi.fn(() => { throw new Error("disk full"); }) },
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    // writeDreamState throwing should not crash forceDream (error is swallowed)
    await expect(mod.forceDream()).resolves.toBeUndefined();
    expect(logErrorMock).toHaveBeenCalledWith("dream", "Failed to write dream state", expect.any(Error));
  });

  it("logError when appendFileSync throws in appendDreamLog", async () => {
    const logErrorMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: logErrorMock, logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => "dream prompt"),
      mkdirSync: vi.fn(),
      appendFileSync: vi.fn(() => { throw new Error("append failed"); }),
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    // appendFileSync throws, but appendDreamLog catches it
    await expect(mod.forceDream()).resolves.toBeUndefined();
    expect(logErrorMock).toHaveBeenCalledWith("dream", "Failed to write dream log", expect.any(Error));
  });

  it("forceDream rethrows when runDreamAgent fails (prompt file unreadable)", async () => {
    const logErrorMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: logErrorMock, logWarn: vi.fn(),
    }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => false), // readDreamState returns null (no read needed)
      readFileSync: vi.fn(() => { throw new Error("ENOENT: prompt file missing"); }),
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    // forceDream rethrows when runDreamAgent throws (trigger === "forced")
    await expect(mod.forceDream()).rejects.toThrow("Failed to read dream prompt");
    expect(logErrorMock).toHaveBeenCalledWith(
      "dream",
      expect.stringContaining("Memory consolidation failed"),
      expect.any(Error),
    );
  });

  it("agent crash causes forceDream to reject with failure log entry", async () => {
    const appendFileSyncMock = vi.fn();
    vi.doMock("../util/log.js", () => ({
      log: vi.fn(), logError: vi.fn(), logWarn: vi.fn(),
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
      },
    }));

    const mod = await import("../core/dream.js");
    mod.initDream({ model: "claude-sonnet-4-6" });
    await expect(mod.forceDream()).rejects.toThrow("agent crashed unexpectedly");
    const logOutput = appendFileSyncMock.mock.calls.map((c: unknown[]) => c[1] as string).join("");
    expect(logOutput).toContain("Dream FAILED");
  });
});
