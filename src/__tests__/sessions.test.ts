import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the log module before importing sessions
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Mock fs to avoid real filesystem side effects
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// We need to import these functions after mocks are set up
const {
  getSession,
  incrementTurns,
  recordUsage,
  resetSession,
  getSessionInfo,
  setSessionId,
  setLastBotMessageId,
  getLastBotMessageId,
  getActiveSessionCount,
} = await import("../storage/sessions.js");

describe("sessions", () => {
  beforeEach(() => {
    // Reset sessions between tests by resetting all known chat IDs
    // We use unique chat IDs per test to avoid cross-contamination
  });

  describe("getSession", () => {
    it("creates a new session with defaults for unknown chat", () => {
      const session = getSession("test-new-chat");
      expect(session.sessionId).toBeUndefined();
      expect(session.turns).toBe(0);
      expect(session.lastActive).toBeGreaterThan(0);
      expect(session.createdAt).toBeGreaterThan(0);
      expect(session.usage).toBeDefined();
      expect(session.usage.totalInputTokens).toBe(0);
      expect(session.usage.totalOutputTokens).toBe(0);
    });

    it("returns the same session on subsequent calls", () => {
      const chatId = "test-same-session";
      const first = getSession(chatId);
      first.turns = 5;
      const second = getSession(chatId);
      expect(second.turns).toBe(5);
    });

    it("initializes usage with all zero fields", () => {
      const session = getSession("test-usage-init");
      expect(session.usage.totalInputTokens).toBe(0);
      expect(session.usage.totalOutputTokens).toBe(0);
      expect(session.usage.totalCacheRead).toBe(0);
      expect(session.usage.totalCacheWrite).toBe(0);
      expect(session.usage.lastPromptTokens).toBe(0);
      expect(session.usage.estimatedCostUsd).toBe(0);
      expect(session.usage.totalResponseMs).toBe(0);
      expect(session.usage.lastResponseMs).toBe(0);
      expect(session.usage.fastestResponseMs).toBe(0);
    });
  });

  describe("incrementTurns", () => {
    it("increments turn count by 1", () => {
      const chatId = "test-inc-turns";
      getSession(chatId); // initialize
      incrementTurns(chatId);
      expect(getSession(chatId).turns).toBe(1);
      incrementTurns(chatId);
      expect(getSession(chatId).turns).toBe(2);
    });

    it("updates lastActive timestamp", () => {
      const chatId = "test-inc-active";
      const before = getSession(chatId).lastActive;
      // Small delay to ensure timestamp changes
      incrementTurns(chatId);
      expect(getSession(chatId).lastActive).toBeGreaterThanOrEqual(before);
    });
  });

  describe("recordUsage", () => {
    it("accumulates token usage correctly", () => {
      const chatId = "test-record-usage";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 10,
        cacheWrite: 5,
      });

      const session = getSession(chatId);
      expect(session.usage.totalInputTokens).toBe(100);
      expect(session.usage.totalOutputTokens).toBe(50);
      expect(session.usage.totalCacheRead).toBe(10);
      expect(session.usage.totalCacheWrite).toBe(5);

      recordUsage(chatId, {
        inputTokens: 200,
        outputTokens: 100,
        cacheRead: 20,
        cacheWrite: 10,
      });

      expect(session.usage.totalInputTokens).toBe(300);
      expect(session.usage.totalOutputTokens).toBe(150);
      expect(session.usage.totalCacheRead).toBe(30);
      expect(session.usage.totalCacheWrite).toBe(15);
    });

    it("updates lastPromptTokens to latest turn snapshot", () => {
      const chatId = "test-prompt-tokens";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 10,
        cacheWrite: 5,
      });
      // lastPromptTokens = inputTokens + cacheRead + cacheWrite
      expect(getSession(chatId).usage.lastPromptTokens).toBe(115);

      recordUsage(chatId, {
        inputTokens: 200,
        outputTokens: 75,
        cacheRead: 30,
        cacheWrite: 20,
      });
      expect(getSession(chatId).usage.lastPromptTokens).toBe(250);
    });

    it("calculates estimated cost", () => {
      const chatId = "test-cost";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // Cost for 1M input tokens at $3/M = $3
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(3, 1);
    });

    it("tracks response time duration", () => {
      const chatId = "test-duration";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        durationMs: 1500,
      });

      const usage = getSession(chatId).usage;
      expect(usage.lastResponseMs).toBe(1500);
      expect(usage.totalResponseMs).toBe(1500);
      expect(usage.fastestResponseMs).toBe(1500);

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        durationMs: 800,
      });

      expect(usage.lastResponseMs).toBe(800);
      expect(usage.totalResponseMs).toBe(2300);
      expect(usage.fastestResponseMs).toBe(800);
    });
  });

  describe("resetSession", () => {
    it("removes the session so a fresh one is created next time", () => {
      const chatId = "test-reset";
      const session = getSession(chatId);
      session.turns = 10;
      setSessionId(chatId, "some-session-id");

      resetSession(chatId);

      const fresh = getSession(chatId);
      expect(fresh.turns).toBe(0);
      expect(fresh.sessionId).toBeUndefined();
    });
  });

  describe("getSessionInfo", () => {
    it("returns correct data for existing session", () => {
      const chatId = "test-info-existing";
      setSessionId(chatId, "sid-123");
      incrementTurns(chatId);

      const info = getSessionInfo(chatId);
      expect(info.sessionId).toBe("sid-123");
      expect(info.turns).toBe(1);
      expect(info.lastActive).toBeGreaterThan(0);
    });

    it("returns defaults for missing session", () => {
      const info = getSessionInfo("nonexistent-chat-id-xyz");
      expect(info.sessionId).toBeUndefined();
      expect(info.turns).toBe(0);
      expect(info.lastActive).toBe(0);
      expect(info.createdAt).toBe(0);
      expect(info.usage.totalInputTokens).toBe(0);
    });
  });

  describe("lastBotMessageId", () => {
    it("stores and retrieves bot message ID", () => {
      const chatId = "test-bot-msg";
      expect(getLastBotMessageId(chatId)).toBeUndefined();

      setLastBotMessageId(chatId, 42);
      expect(getLastBotMessageId(chatId)).toBe(42);
    });
  });

  describe("setSessionId", () => {
    it("persists session ID", () => {
      const chatId = "test-set-sid";
      setSessionId(chatId, "abc-123");
      expect(getSession(chatId).sessionId).toBe("abc-123");
    });
  });
});
