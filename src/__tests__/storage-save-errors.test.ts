/**
 * Tests that cover the logError + recordError paths triggered when
 * write-file-atomic throws during save() in cron-store, chat-settings,
 * and sessions.
 *
 * Each module must be re-imported in isolation (vi.resetModules) so the
 * mocks apply to the fresh module instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── cron-store save failure ───────────────────────────────────────────────

describe("cron-store — save failure logs error", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls logError and recordError when writeFileAtomic throws", async () => {
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
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => "{}"),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    }));
    vi.doMock("write-file-atomic", () => ({
      default: {
        sync: vi.fn(() => {
          throw new Error("disk full");
        }),
      },
    }));
    vi.doMock("../util/paths.js", () => ({
      files: { cron: "/fake/cron.json" },
      dirs: { root: "/fake/.talon" },
    }));
    vi.doMock("../util/cleanup-registry.js", () => ({
      registerCleanup: vi.fn(),
    }));

    const { addCronJob, generateCronId } =
      await import("../storage/cron-store.js");

    const job = {
      id: generateCronId(),
      chatId: "chat1",
      schedule: "0 * * * *",
      type: "message" as const,
      content: "hello",
      name: "test",
      enabled: true,
      createdAt: Date.now(),
      runCount: 0,
    };

    // addCronJob marks dirty and calls save() which will throw
    addCronJob(job);

    expect(logErrorMock).toHaveBeenCalledWith(
      "cron",
      expect.stringContaining("Failed to persist"),
      expect.any(Error),
    );
    expect(recordErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Cron save failed"),
    );

    clearInterval(((await import("../storage/cron-store.js")) as any)._timer);
  });
});

// ── chat-settings save failure ────────────────────────────────────────────

describe("chat-settings — save failure logs error", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("calls logError and recordError when writeFileAtomic throws", async () => {
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
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => "{}"),
      mkdirSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({
      default: {
        sync: vi.fn(() => {
          throw new Error("readonly fs");
        }),
      },
    }));
    vi.doMock("../util/paths.js", () => ({
      files: { chatSettings: "/fake/chat-settings.json" },
      dirs: { root: "/fake/.talon" },
    }));
    vi.doMock("../util/cleanup-registry.js", () => ({
      registerCleanup: vi.fn(),
    }));

    const { setChatModel } = await import("../storage/chat-settings.js");

    // setChatModel marks dirty and calls save()
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

describe("chat-settings — non-Error thrown in save (line 96 FALSE branch)", () => {
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
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => "{}"),
      mkdirSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({
      default: {
        sync: vi.fn(() => {
          throw "plain string chat-settings error";
        }),
      },
    }));
    vi.doMock("../util/paths.js", () => ({
      files: { chatSettings: "/fake/chat-settings.json" },
      dirs: { root: "/fake/.talon" },
    }));
    vi.doMock("../util/cleanup-registry.js", () => ({
      registerCleanup: vi.fn(),
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

  it("calls logError and recordError when writeFileAtomic throws", async () => {
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
    vi.doMock("node:fs", () => ({
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => "{}"),
      mkdirSync: vi.fn(),
    }));
    vi.doMock("write-file-atomic", () => ({
      default: {
        sync: vi.fn(() => {
          throw new Error("ENOSPC: no space left");
        }),
      },
    }));
    vi.doMock("../util/paths.js", () => ({
      files: { sessions: "/fake/sessions.json" },
      dirs: { root: "/fake/.talon", data: "/fake/.talon/data" },
    }));
    vi.doMock("../util/cleanup-registry.js", () => ({
      registerCleanup: vi.fn(),
    }));

    const { getSession, flushSessions } =
      await import("../storage/sessions.js");

    // getSession creates a new session (marks dirty) then flushSessions forces save
    getSession("chat-save-fail");
    flushSessions();

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
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
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
    }));
    vi.doMock("write-file-atomic", () => ({ default: { sync: vi.fn() } }));
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
