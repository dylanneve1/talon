import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../util/watchdog.js", () => ({
  recordError: vi.fn(),
}));

const inMemoryFiles = new Map<string, string>();

const existsSyncMock = vi.fn((p: string) => inMemoryFiles.has(p));
const readFileSyncMock = vi.fn((p: string) => inMemoryFiles.get(p) ?? "");
const writeFileSyncFsMock = vi.fn((p: string, body: string, _opts?: unknown) =>
  inMemoryFiles.set(p, body),
);
const mkdirSyncMock = vi.fn();
const rmSyncMock = vi.fn((p: string) => inMemoryFiles.delete(p));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncFsMock,
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock,
}));

const writeAtomicSyncMock = vi.fn((p: string, body: string) =>
  inMemoryFiles.set(p, body),
);
vi.mock("write-file-atomic", () => ({
  default: { sync: writeAtomicSyncMock },
}));

import type { Trigger } from "../storage/trigger-store.js";
import { files as pathFiles } from "../util/paths.js";

const {
  loadTriggers,
  flushTriggers,
  addTrigger,
  getTrigger,
  getTriggersForChat,
  getActiveTriggersForChat,
  getTriggerByName,
  updateTrigger,
  deleteTrigger,
  generateTriggerId,
  validateLanguage,
  validateName,
  validateScript,
  validateTimeout,
  writeScriptFile,
  triggerScriptPath,
  triggerLogPath,
  readTriggerLogTail,
  sanitizeChatId,
  DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS,
  MAX_ACTIVE_PER_CHAT,
  _resetTriggersForTesting,
} = await import("../storage/trigger-store.js");

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  const id = generateTriggerId();
  return {
    id,
    chatId: "chat-1",
    numericChatId: 1,
    name: "watch-pr",
    language: "bash",
    scriptPath: `/tmp/trigger-runs/chat-1/${id}.sh`,
    logPath: `/tmp/trigger-runs/chat-1/${id}.log`,
    status: "running",
    createdAt: Date.now(),
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    fireCount: 0,
    ...overrides,
  };
}

describe("trigger-store", () => {
  beforeEach(() => {
    _resetTriggersForTesting();
    inMemoryFiles.clear();
    vi.clearAllMocks();
  });

  describe("constants", () => {
    it("exposes sane defaults", () => {
      expect(DEFAULT_TIMEOUT_SECONDS).toBe(24 * 60 * 60);
      expect(MAX_TIMEOUT_SECONDS).toBe(7 * 24 * 60 * 60);
      expect(MAX_ACTIVE_PER_CHAT).toBe(5);
    });
  });

  describe("validation", () => {
    it("validateLanguage accepts only the three supported languages", () => {
      expect(validateLanguage("bash")).toBe(true);
      expect(validateLanguage("python")).toBe(true);
      expect(validateLanguage("node")).toBe(true);
      expect(validateLanguage("ruby")).toBe(false);
      expect(validateLanguage(undefined)).toBe(false);
      expect(validateLanguage(123)).toBe(false);
    });

    it("validateName requires a sane identifier", () => {
      expect(validateName("watch-pr")).toBeNull();
      expect(validateName("Watch PR 35337")).toBeNull();
      expect(validateName("foo.bar_baz")).toBeNull();
      expect(validateName("")).toMatch(/Missing/);
      expect(validateName("has/slash")).toMatch(/letters/);
      expect(validateName("a".repeat(65))).toMatch(/letters/);
    });

    it("validateScript rejects empty and oversized scripts", () => {
      expect(validateScript("echo ok")).toBeNull();
      expect(validateScript("")).toMatch(/Missing/);
      expect(validateScript("   ")).toMatch(/Missing/);
      expect(validateScript("x".repeat(70_000))).toMatch(/too large/);
    });

    it("validateTimeout enforces bounds", () => {
      expect(validateTimeout(60)).toBeNull();
      expect(validateTimeout(MAX_TIMEOUT_SECONDS)).toBeNull();
      expect(validateTimeout(0)).toMatch(/positive/);
      expect(validateTimeout(-1)).toMatch(/positive/);
      expect(validateTimeout(NaN)).toMatch(/positive/);
      expect(validateTimeout(MAX_TIMEOUT_SECONDS + 1)).toMatch(/exceeds max/);
    });
  });

  describe("path helpers", () => {
    it("sanitizeChatId strips path-unsafe characters", () => {
      expect(sanitizeChatId("352042062")).toBe("352042062");
      expect(sanitizeChatId("-100123")).toBe("-100123");
      expect(sanitizeChatId("../etc/passwd")).toBe("___etc_passwd");
    });

    it("triggerScriptPath uses the language extension", () => {
      const id = generateTriggerId();
      expect(triggerScriptPath("c1", id, "bash")).toMatch(
        new RegExp(`/c1/${id}\\.sh$`),
      );
      expect(triggerScriptPath("c1", id, "python")).toMatch(/\.py$/);
      expect(triggerScriptPath("c1", id, "node")).toMatch(/\.js$/);
    });

    it("triggerLogPath always uses .log", () => {
      const id = generateTriggerId();
      expect(triggerLogPath("c1", id)).toMatch(/\.log$/);
    });
  });

  describe("CRUD", () => {
    it("addTrigger / getTrigger round-trips a record", () => {
      const t = makeTrigger();
      addTrigger(t);
      const retrieved = getTrigger(t.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.name).toBe("watch-pr");
      expect(retrieved!.language).toBe("bash");
    });

    it("getTriggersForChat scopes correctly", () => {
      addTrigger(makeTrigger({ chatId: "a" }));
      addTrigger(makeTrigger({ chatId: "a", name: "second" }));
      addTrigger(makeTrigger({ chatId: "b" }));
      expect(getTriggersForChat("a")).toHaveLength(2);
      expect(getTriggersForChat("b")).toHaveLength(1);
      expect(getTriggersForChat("c")).toHaveLength(0);
    });

    it("getActiveTriggersForChat only returns running/pending", () => {
      addTrigger(makeTrigger({ chatId: "a", status: "running" }));
      addTrigger(makeTrigger({ chatId: "a", name: "two", status: "pending" }));
      addTrigger(makeTrigger({ chatId: "a", name: "three", status: "fired" }));
      addTrigger(makeTrigger({ chatId: "a", name: "four", status: "errored" }));
      expect(getActiveTriggersForChat("a")).toHaveLength(2);
    });

    it("getTriggerByName scopes to chat", () => {
      addTrigger(makeTrigger({ chatId: "a", name: "shared" }));
      addTrigger(makeTrigger({ chatId: "b", name: "shared" }));
      expect(getTriggerByName("a", "shared")?.chatId).toBe("a");
      expect(getTriggerByName("b", "shared")?.chatId).toBe("b");
      expect(getTriggerByName("c", "shared")).toBeUndefined();
    });

    it("updateTrigger merges fields", () => {
      const t = makeTrigger();
      addTrigger(t);
      updateTrigger(t.id, { status: "fired", exitCode: 0, fireCount: 1 });
      const updated = getTrigger(t.id);
      expect(updated!.status).toBe("fired");
      expect(updated!.exitCode).toBe(0);
      expect(updated!.fireCount).toBe(1);
    });

    it("deleteTrigger removes from store and rms files", () => {
      const t = makeTrigger();
      addTrigger(t);
      expect(deleteTrigger(t.id)).toBe(true);
      expect(getTrigger(t.id)).toBeUndefined();
      // best-effort rmSync on script + log
      expect(rmSyncMock).toHaveBeenCalledTimes(2);
    });

    it("deleteTrigger returns false for unknown id", () => {
      expect(deleteTrigger("nope")).toBe(false);
    });
  });

  describe("loadTriggers — restart cleanup", () => {
    it("marks running/pending triggers as terminated on load", () => {
      const t = makeTrigger({ status: "running", pid: 999 });
      const persisted = JSON.stringify({ [t.id]: t });
      inMemoryFiles.set(pathFiles.triggers, persisted);

      _resetTriggersForTesting();
      loadTriggers();

      const restored = getTrigger(t.id);
      expect(restored).toBeDefined();
      expect(restored!.status).toBe("terminated");
      expect(restored!.pid).toBeUndefined();
      expect(restored!.lastError).toMatch(/restarted/);
    });

    it("preserves terminal statuses across load", () => {
      const t = makeTrigger({
        status: "fired",
        endedAt: Date.now() - 60_000,
        exitCode: 0,
      });
      inMemoryFiles.set(pathFiles.triggers, JSON.stringify({ [t.id]: t }));
      _resetTriggersForTesting();
      loadTriggers();
      expect(getTrigger(t.id)!.status).toBe("fired");
    });
  });

  describe("flushTriggers", () => {
    it("does not throw when nothing is dirty", () => {
      expect(() => flushTriggers()).not.toThrow();
    });
  });

  describe("writeScriptFile", () => {
    it("writes the script body and returns the path", () => {
      const path = writeScriptFile("c1", "trig_x", "bash", "echo hi");
      expect(path).toMatch(/\.sh$/);
      expect(writeFileSyncFsMock).toHaveBeenCalled();
      const [calledPath, body, opts] = writeFileSyncFsMock.mock.calls[0];
      expect(calledPath).toBe(path);
      expect(body).toBe("echo hi");
      expect((opts as { mode: number }).mode).toBe(0o700);
    });
  });

  describe("readTriggerLogTail", () => {
    it("returns empty for a non-existent log", () => {
      const result = readTriggerLogTail("/nope.log", 10);
      expect(result.tail).toBe("");
      expect(result.truncated).toBe(false);
    });

    it("returns last N lines and flags truncation", () => {
      const path = "/tmp/trigger-runs/x.log";
      const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
      inMemoryFiles.set(path, lines.join("\n"));
      const result = readTriggerLogTail(path, 5);
      expect(result.truncated).toBe(true);
      expect(result.tail.split("\n")).toEqual([
        "line 16",
        "line 17",
        "line 18",
        "line 19",
        "line 20",
      ]);
    });

    it("returns full content untruncated when small enough", () => {
      const path = "/tmp/trigger-runs/y.log";
      inMemoryFiles.set(path, "a\nb\nc");
      const result = readTriggerLogTail(path, 10);
      expect(result.truncated).toBe(false);
      expect(result.tail).toBe("a\nb\nc");
    });
  });
});
