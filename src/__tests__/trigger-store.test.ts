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
const renameSyncMock = vi.fn((from: string, to: string) => {
  const v = inMemoryFiles.get(from);
  if (v === undefined) return;
  inMemoryFiles.set(to, v);
  inMemoryFiles.delete(from);
});
const unlinkSyncMock = vi.fn((p: string) => inMemoryFiles.delete(p));

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncFsMock,
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock,
  renameSync: renameSyncMock,
  unlinkSync: unlinkSyncMock,
}));

const writeAtomicSyncMock = vi.fn((p: string, body: string) =>
  inMemoryFiles.set(p, body),
);
vi.mock("write-file-atomic", () => ({
  default: Object.assign(
    (...args: unknown[]) => writeAtomicSyncMock(...(args as [string, string])),
    { sync: writeAtomicSyncMock },
  ),
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
    it("validateLanguage accepts only the four supported languages", () => {
      expect(validateLanguage("bash")).toBe(true);
      expect(validateLanguage("python")).toBe(true);
      expect(validateLanguage("node")).toBe(true);
      expect(validateLanguage("lua")).toBe(true);
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
      // Normalise path separators for cross-platform compat (Windows uses \)
      const norm = (p: string) => p.replace(/\\/g, "/");
      expect(norm(triggerScriptPath("c1", id, "bash"))).toMatch(
        new RegExp(`/c1/${id}\\.sh$`),
      );
      expect(triggerScriptPath("c1", id, "python")).toMatch(/\.py$/);
      expect(triggerScriptPath("c1", id, "node")).toMatch(/\.js$/);
      expect(triggerScriptPath("c1", id, "lua")).toMatch(/\.lua$/);
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

    it("parks persistent running triggers as pending and preserves pid for orphan check", () => {
      const t = makeTrigger({ status: "running", pid: 1234, persistent: true });
      inMemoryFiles.set(pathFiles.triggers, JSON.stringify({ [t.id]: t }));

      _resetTriggersForTesting();
      loadTriggers();

      const restored = getTrigger(t.id)!;
      expect(restored.status).toBe("pending");
      // pid is kept so resumeAfterRestart() can detect/kill an orphaned child
      expect(restored.pid).toBe(1234);
      expect(restored.lastError).toBeUndefined();
      expect(restored.endedAt).toBeUndefined();
    });

    it("does not touch persistent triggers already in terminal state", () => {
      const t = makeTrigger({
        status: "cancelled",
        persistent: true,
        endedAt: Date.now() - 1000,
        lastError: "Cancelled by user",
      });
      inMemoryFiles.set(pathFiles.triggers, JSON.stringify({ [t.id]: t }));

      _resetTriggersForTesting();
      loadTriggers();

      // Cancelled persistent stays cancelled — only running/pending are converted
      expect(getTrigger(t.id)!.status).toBe("cancelled");
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

    it("uses String(err) when readFileSync throws a non-Error (Branch 32 false arm)", () => {
      // A path that exists (so existsSync passes) but readFileSync throws a string
      const path = "/tmp/trigger-runs/err-string.log";
      inMemoryFiles.set(path, "dummy"); // existsSyncMock returns true
      readFileSyncMock.mockImplementationOnce(() => {
        throw "string readFileSync error"; // non-Error → false arm of err instanceof Error
      });
      const result = readTriggerLogTail(path, 10);
      expect(result.tail).toMatch(/Failed to read log/);
      expect(result.truncated).toBe(false);
    });
  });

  // ── loadTriggers — file not present (Branch 0 false arm) ──────────────────

  describe("loadTriggers — file not present", () => {
    it("starts with empty store when triggers file does not exist", () => {
      // inMemoryFiles is empty → existsSyncMock returns false → skip reading
      _resetTriggersForTesting();
      loadTriggers();
      expect(getTrigger("any")).toBeUndefined();
    });
  });

  // ── loadTriggers — non-object JSON (Branch 1 false arm) ───────────────────

  describe("loadTriggers — non-object JSON", () => {
    it("falls back to empty store when primary JSON is null", () => {
      inMemoryFiles.set(pathFiles.triggers, "null");
      _resetTriggersForTesting();
      loadTriggers(); // Branch 0 true, Branch 1 false arm (null is not a valid store object)
      expect(getTrigger("any")).toBeUndefined();
    });
  });

  // ── loadTriggers — corrupt primary file (Branches 3, 4, 5) ───────────────

  describe("loadTriggers — corrupt primary file", () => {
    it("handles corrupt primary with no backup (outer catch, inner if-false)", () => {
      inMemoryFiles.set(pathFiles.triggers, "{ invalid json }");
      _resetTriggersForTesting();
      loadTriggers(); // outer catch fired; existsSync(bakFile)=false → inner if false
      expect(getTrigger("any")).toBeUndefined();
    });

    it("loads from backup when primary is corrupt and backup is valid", () => {
      const id = generateTriggerId();
      const t = makeTrigger({ id, status: "fired", exitCode: 0 });
      inMemoryFiles.set(pathFiles.triggers, "{ bad json");
      inMemoryFiles.set(
        pathFiles.triggers + ".bak",
        JSON.stringify({ [id]: t }),
      );
      _resetTriggersForTesting();
      loadTriggers(); // outer catch; existsSync(bakFile)=true; backup loaded (Branches 3-5)
      expect(getTrigger(id)?.status).toBe("fired");
    });

    it("handles corrupt primary AND corrupt backup gracefully (inner catch)", () => {
      inMemoryFiles.set(pathFiles.triggers, "{ bad primary");
      inMemoryFiles.set(pathFiles.triggers + ".bak", "{ bad backup");
      _resetTriggersForTesting();
      loadTriggers(); // outer catch; existsSync(bakFile)=true; JSON.parse throws → inner catch
      expect(getTrigger("any")).toBeUndefined();
    });

    it("falls back to empty when backup parses as null (Branch 94 false arm: typeof raw === 'object' && raw !== null)", () => {
      // backup file exists and is valid JSON, but parses to null → ternary false arm → store = {}
      inMemoryFiles.set(pathFiles.triggers, "{ bad primary");
      inMemoryFiles.set(pathFiles.triggers + ".bak", "null");
      _resetTriggersForTesting();
      loadTriggers();
      expect(getTrigger("any")).toBeUndefined();
    });
  });

  // ── save() error paths (Branch 15) ────────────────────────────────────────

  describe("save() error paths", () => {
    it("catches and logs when writeFileAtomic.sync throws an Error", () => {
      writeAtomicSyncMock.mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      // addTrigger → save() → writeAtomicSyncMock throws → caught inside save()
      expect(() => addTrigger(makeTrigger())).not.toThrow();
      // The file was NOT written (write threw before setting inMemoryFiles)
      expect(inMemoryFiles.has(pathFiles.triggers)).toBe(false);
    });

    it("catches and logs when writeFileAtomic.sync throws a non-Error (Branch 15 false arm)", () => {
      writeAtomicSyncMock.mockImplementationOnce(() => {
        throw "plain string disk error"; // non-Error → covers false arm of err instanceof Error
      });
      expect(() => addTrigger(makeTrigger())).not.toThrow();
      expect(inMemoryFiles.has(pathFiles.triggers)).toBe(false);
    });
  });
});
