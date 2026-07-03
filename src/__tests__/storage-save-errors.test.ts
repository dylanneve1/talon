/**
 * Tests that cover the logError + recordError paths triggered when a
 * persistence write throws. In the SQLite era every write commits
 * transactionally, so there is no flush-to-disk failure to catch. The
 * remaining swallow-and-record paths are:
 *   - cron-store.recordCronRun — runs inside the scheduler tick, so a DB
 *     failure must be logged + recorded, never thrown (CRUD, by contrast,
 *     lets DB errors propagate).
 *   - sessions.persist / chat-settings.persist — catch repo errors and
 *     recordError while keeping the in-memory cache authoritative.
 *
 * Each module is re-imported in isolation (vi.resetModules) so the mocks
 * apply to the fresh module instance. The failing repository is injected
 * as a mock; the real db.ts transaction wrapper runs against the worker's
 * throwaway database.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── cron-store recordCronRun swallows a repository failure ────────────────

describe("cron-store — recordCronRun swallows a repository error", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("logs + records (does not throw) when the repo write throws in the tick", async () => {
    const logErrorMock = vi.fn();
    const recordErrorMock = vi.fn();

    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: logErrorMock,
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/watchdog.js", () => ({
      recordError: recordErrorMock,
    }));
    // A repo whose read finds the job but whose write blows up mid-tick.
    vi.doMock("../storage/repositories/cron-repo.js", () => ({
      get: vi.fn(() => ({
        id: "cron-fail",
        chatId: "chat1",
        schedule: "0 * * * *",
        type: "message" as const,
        content: "hello",
        name: "test",
        enabled: true,
        createdAt: Date.now(),
        runCount: 0,
      })),
      upsert: vi.fn(() => {
        throw new Error("database is locked");
      }),
      listAll: vi.fn(() => []),
      count: vi.fn(() => 0),
      removeAll: vi.fn(),
    }));

    const { recordCronRun } = await import("../storage/cron-store.js");

    // recordCronRun wraps the read+write in a transaction; the write throws,
    // the transaction rolls back, and recordCronRun swallows + records it.
    expect(() =>
      recordCronRun("cron-fail", { status: "ok", durationMs: 5 }),
    ).not.toThrow();

    expect(logErrorMock).toHaveBeenCalledWith(
      "cron",
      expect.stringContaining("Failed to record cron run"),
      expect.any(Error),
    );
    expect(recordErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Cron run record failed"),
    );
  });
});

// ── chat-settings save failure ────────────────────────────────────────────

describe("chat-settings — save failure logs error", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls logError and recordError when the SQLite write throws", async () => {
    const logErrorMock = vi.fn();
    const recordErrorMock = vi.fn();

    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: logErrorMock,
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/watchdog.js", () => ({
      recordError: recordErrorMock,
    }));
    vi.doMock("../storage/repositories/chat-settings-repo.js", () => ({
      upsert: vi.fn(() => {
        throw new Error("database is locked");
      }),
      upsertMany: vi.fn(() => 0),
      all: vi.fn(() => []),
      remove: vi.fn(),
      checkpoint: vi.fn(),
    }));

    const { setChatModel } = await import("../storage/chat-settings.js");

    // setChatModel mutates the cache then commits the row, which throws
    setChatModel("chat99", "claude-opus-4-6");

    expect(logErrorMock).toHaveBeenCalledWith(
      "settings",
      expect.stringContaining("Failed to persist"),
      expect.any(Error),
    );
    expect(recordErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Settings save failed"),
    );
  });
});

describe("chat-settings — non-Error thrown in save (persist FALSE branch)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("records error with String(err) when non-Error is thrown", async () => {
    const recordErrorMock = vi.fn();

    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/watchdog.js", () => ({
      recordError: recordErrorMock,
    }));
    vi.doMock("../storage/repositories/chat-settings-repo.js", () => ({
      upsert: vi.fn(() => {
        throw "plain string chat-settings error";
      }),
      upsertMany: vi.fn(() => 0),
      all: vi.fn(() => []),
      remove: vi.fn(),
      checkpoint: vi.fn(),
    }));

    const { setChatModel } = await import("../storage/chat-settings.js");
    setChatModel("chat-nonError", "claude-opus-4-6");

    expect(recordErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("plain string chat-settings error"),
    );
  });
});

// ── sessions save failure ─────────────────────────────────────────────────

describe("sessions — save failure logs error", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls logError and recordError when the SQLite write throws", async () => {
    const logErrorMock = vi.fn();
    const recordErrorMock = vi.fn();

    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: logErrorMock,
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/watchdog.js", () => ({
      recordError: recordErrorMock,
    }));
    vi.doMock("../storage/repositories/sessions-repo.js", () => ({
      upsert: vi.fn(() => {
        throw new Error("ENOSPC: no space left");
      }),
      upsertMany: vi.fn(() => 0),
      all: vi.fn(() => []),
      remove: vi.fn(),
      checkpoint: vi.fn(),
    }));

    const { getSession } = await import("../storage/sessions.js");

    // getSession creates a new session and commits the row, which throws;
    // the persist path must swallow it (logError + recordError), not crash.
    expect(() => getSession("chat-save-fail")).not.toThrow();

    expect(logErrorMock).toHaveBeenCalledWith(
      "sessions",
      expect.stringContaining("Failed to persist"),
      expect.any(Error),
    );
    expect(recordErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Session save failed"),
    );
  });
});

// ── sessions — migration of totalResponseMs / lastResponseMs ─────────────

describe("sessions — migration paths for usage fields", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sets totalResponseMs to 0 when undefined in stored session", async () => {
    const partialUsage = {
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      lastPromptTokens: 0,
      estimatedCostUsd: 0,
      // totalResponseMs intentionally omitted
      lastResponseMs: 0,
      fastestResponseMs: Infinity,
    };
    const stored = {
      "mig-chat": {
        sessionId: undefined,
        turns: 1,
        lastActive: Date.now(),
        createdAt: Date.now(),
        usage: partialUsage,
      },
    };

    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify(stored)),
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: { sessions: "/fake/sessions.json" },
      dirs: { root: "/fake/.talon", data: "/fake/.talon/data" },
    }));
    vi.doMock("../util/cleanup-registry.js", () => ({
      registerCleanup: vi.fn(),
    }));

    const { loadSessions, getSession } = await import("../storage/sessions.js");
    loadSessions();
    const session = getSession("mig-chat");
    expect(session.usage.totalResponseMs).toBe(0);
  });

  it("sets lastResponseMs to 0 when undefined in stored session", async () => {
    const partialUsage = {
      totalInputTokens: 10,
      totalOutputTokens: 5,
      totalCacheRead: 0,
      totalCacheWrite: 0,
      lastPromptTokens: 0,
      estimatedCostUsd: 0,
      totalResponseMs: 100,
      // lastResponseMs intentionally omitted
      fastestResponseMs: Infinity,
    };
    const stored = {
      "mig-chat-2": {
        sessionId: undefined,
        turns: 1,
        lastActive: Date.now(),
        createdAt: Date.now(),
        usage: partialUsage,
      },
    };

    vi.doMock("../util/log.js", () => ({
      log: vi.fn(),
      logError: vi.fn(),
      logWarn: vi.fn(),
    }));
    vi.doMock("../util/watchdog.js", () => ({ recordError: vi.fn() }));
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => JSON.stringify(stored)),
      mkdirSync: vi.fn(),
      renameSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
    vi.doMock("../util/paths.js", () => ({
      files: { sessions: "/fake/sessions.json" },
      dirs: { root: "/fake/.talon", data: "/fake/.talon/data" },
    }));
    vi.doMock("../util/cleanup-registry.js", () => ({
      registerCleanup: vi.fn(),
    }));

    const { loadSessions, getSession } = await import("../storage/sessions.js");
    loadSessions();
    const session = getSession("mig-chat-2");
    expect(session.usage.lastResponseMs).toBe(0);
  });
});
