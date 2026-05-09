/**
 * Extended branch coverage for src/core/triggers.ts.
 *
 * Complements src/__tests__/triggers.test.ts.  Those tests cover the happy
 * paths (bash, cancel, timeout, shutdown, TALON_FIRE).  This file covers the
 * remaining uncovered branches needed to stay above the 60% global threshold:
 *
 *   - python / node language paths in commandForLanguage
 *   - spawnTrigger idempotency guard
 *   - cancelTrigger returning false for an unknown trigger
 *   - resumeAfterRestart: no-deps guard, empty store, matching trigger
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Silence the logger
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

const {
  initTriggers,
  spawnTrigger,
  cancelTrigger,
  getRunningCount,
  resumeAfterRestart,
} = await import("../core/triggers.js");

import type { Trigger } from "../storage/trigger-store.js";
const {
  addTrigger,
  generateTriggerId,
  getTrigger,
  updateTrigger,
  deleteTrigger,
  _resetTriggersForTesting,
  DEFAULT_TIMEOUT_SECONDS,
  FIRE_PAYLOAD_MAX_BYTES,
} = await import("../storage/trigger-store.js");

let tmpRoot: string;
let executeSpy: ReturnType<typeof vi.fn>;

function makeTrigger(opts: {
  body: string;
  language?: "bash" | "python" | "node";
  ext?: string;
}): Trigger {
  const id = generateTriggerId();
  const language = opts.language ?? "bash";
  const ext =
    opts.ext ??
    (language === "bash" ? "sh" : language === "python" ? "py" : "js");
  const scriptPath = resolve(tmpRoot, `${id}.${ext}`);
  const logPath = resolve(tmpRoot, `${id}.log`);
  writeFileSync(scriptPath, opts.body, { mode: 0o700 });
  const t: Trigger = {
    id,
    chatId: "chat-ext",
    numericChatId: 2,
    name: `t-${id.slice(-6)}`,
    language,
    scriptPath,
    logPath,
    status: "pending",
    createdAt: Date.now(),
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    fireCount: 0,
  };
  addTrigger(t);
  return t;
}

function waitForStatus(
  id: string,
  predicate: (s: string) => boolean,
  timeoutMs = 8000,
): Promise<void> {
  return new Promise((res, rej) => {
    const start = Date.now();
    const tick = () => {
      const t = getTrigger(id);
      if (t && predicate(t.status)) return res();
      if (Date.now() - start > timeoutMs)
        return rej(new Error(`timeout (id=${id} status=${t?.status})`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

beforeAll(() => {
  tmpRoot = mkdtempSync(resolve(tmpdir(), "talon-trig-ext-"));
  mkdirSync(tmpRoot, { recursive: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  _resetTriggersForTesting();
  executeSpy = vi.fn(async () => ({
    text: "ok",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 0,
  }));
  initTriggers({ execute: executeSpy as never });
});

// ── Language paths ────────────────────────────────────────────────────────

describe("triggers — alternate languages", () => {
  it("spawns a python trigger and fires on exit 0", async () => {
    const t = makeTrigger({
      body: 'print("py done")\n',
      language: "python",
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");
    expect(getTrigger(t.id)!.exitCode).toBe(0);
    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: fired/);
  });

  it("spawns a node trigger and fires on exit 0", async () => {
    const t = makeTrigger({
      body: 'process.stdout.write("js done\\n"); process.exit(0);\n',
      language: "node",
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");
    expect(getTrigger(t.id)!.exitCode).toBe(0);
    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: fired/);
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────

describe("triggers — idempotency", () => {
  it("calling spawnTrigger twice on the same id is a no-op", async () => {
    const t = makeTrigger({ body: 'echo "once"\nexit 0\n' });
    spawnTrigger(t); // first call — spawns
    spawnTrigger(t); // second call — should return early (idempotent guard)
    // Only one child should be tracked
    expect(getRunningCount()).toBeLessThanOrEqual(1);
    await waitForStatus(t.id, (s) => s === "fired");
    // dispatch called exactly once
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

// ── cancelTrigger false return ────────────────────────────────────────────

describe("triggers — cancelTrigger", () => {
  it("returns false when no child is running for that id", () => {
    expect(cancelTrigger("nonexistent-id-xyz")).toBe(false);
  });
});

// ── resumeAfterRestart ────────────────────────────────────────────────────

describe("triggers — resumeAfterRestart", () => {
  it("is a no-op when called before initTriggers (no deps)", async () => {
    // Temporarily break the deps by resetting
    _resetTriggersForTesting();
    // Don't call initTriggers — deps is now null
    await expect(resumeAfterRestart()).resolves.toBeUndefined();
    expect(executeSpy).not.toHaveBeenCalled();
    // Re-init for subsequent tests
    initTriggers({ execute: executeSpy as never });
  });

  it("is a no-op when the trigger store is empty", async () => {
    await resumeAfterRestart();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("fires a wake-up for a recently-terminated trigger that never fired", async () => {
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-resume",
      numericChatId: 3,
      name: "resume-test",
      language: "bash",
      scriptPath: "/tmp/nonexistent.sh",
      logPath: "/tmp/nonexistent.log",
      status: "terminated",
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 5_000, // 5 seconds ago — within the 5-min window
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
      lastError: "Killed by Talon shutdown",
      // lastFireAt intentionally omitted (undefined) → matches resume condition
    };
    addTrigger(t);

    await resumeAfterRestart();

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const call = executeSpy.mock.calls[0][0];
    expect(call.chatId).toBe("chat-resume");
    expect(call.prompt).toMatch(/terminated/);
  });

  it("does NOT fire for a trigger that already fired", async () => {
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-resume2",
      numericChatId: 4,
      name: "resume-already-fired",
      language: "bash",
      scriptPath: "/tmp/nonexistent2.sh",
      logPath: "/tmp/nonexistent2.log",
      status: "terminated",
      createdAt: Date.now() - 10_000,
      endedAt: Date.now() - 5_000,
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 1,
      lastFireAt: Date.now() - 6_000, // has already fired → condition excludes it
    };
    addTrigger(t);

    await resumeAfterRestart();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("does NOT fire for an old terminated trigger (>5 min ago)", async () => {
    const id = generateTriggerId();
    const t: Trigger = {
      id,
      chatId: "chat-old",
      numericChatId: 5,
      name: "resume-old",
      language: "bash",
      scriptPath: "/tmp/old.sh",
      logPath: "/tmp/old.log",
      status: "terminated",
      createdAt: Date.now() - 600_000,
      endedAt: Date.now() - 310_000, // >5 min ago → outside the window
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      fireCount: 0,
    };
    addTrigger(t);

    await resumeAfterRestart();
    expect(executeSpy).not.toHaveBeenCalled();
  });
});

// ── trigger-store branch coverage ────────────────────────────────────────────

describe("trigger-store — branch coverage", () => {
  it("updateTrigger returns undefined for an unknown id", () => {
    expect(
      updateTrigger("does-not-exist", { status: "fired" }),
    ).toBeUndefined();
  });

  it("deleteTrigger returns false for an unknown id", () => {
    expect(deleteTrigger("does-not-exist")).toBe(false);
  });
});

// ── Large payload / buffer truncation ────────────────────────────────────────

describe("triggers — large stdout payload truncation", () => {
  it("truncates a payload that exceeds FIRE_PAYLOAD_MAX_BYTES", async () => {
    // Emit a line that is larger than FIRE_PAYLOAD_MAX_BYTES bytes so the
    // bufferAsPayload / trimmed path in fireWake is exercised.
    const bigLine = "x".repeat(FIRE_PAYLOAD_MAX_BYTES + 128);
    const t = makeTrigger({
      body: `echo "${bigLine}"\nexit 0\n`,
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "fired");
    const call = executeSpy.mock.calls[0][0];
    // The prompt should have been truncated to at most FIRE_PAYLOAD_MAX_BYTES
    // characters in the payload section (header + trimmed body)
    expect(call.prompt.length).toBeLessThan(FIRE_PAYLOAD_MAX_BYTES + 512);
  });
});

// ── finalizeExit with pre-terminal status ────────────────────────────────────

describe("triggers — finalizeExit status branch", () => {
  it("handles a trigger that had status='cancelled' when it exits", async () => {
    // Spawn, wait until running, cancel — then the child exits.
    // finalizeExit sees status='cancelled' (not 'running') → else branch.
    const t = makeTrigger({ body: "sleep 60\n" });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "running");
    const cancelled = cancelTrigger(t.id);
    expect(cancelled).toBe(true);
    await waitForStatus(t.id, (s) => s === "cancelled");
    // The trigger ended — status should stay cancelled (not be overwritten)
    expect(getTrigger(t.id)!.status).toBe("cancelled");
  });

  it("handles non-zero exit code in the errored path", async () => {
    const t = makeTrigger({
      body: 'echo "fail output"\nexit 3\n',
    });
    spawnTrigger(t);
    await waitForStatus(t.id, (s) => s === "errored");
    expect(getTrigger(t.id)!.exitCode).toBe(3);
    const call = executeSpy.mock.calls[0][0];
    expect(call.prompt).toMatch(/Status: errored/);
    // exit-code header should be in the payload
    expect(call.prompt).toMatch(/exit 3/);
  });
});
