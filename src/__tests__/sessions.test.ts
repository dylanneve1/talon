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

const writeFileAtomicSync = vi.fn();
vi.mock("write-file-atomic", () => ({
  default: { sync: writeFileAtomicSync },
}));

import { existsSync, readFileSync } from "node:fs";

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
  setSessionName,
  getAllSessions,
  loadSessions,
  flushSessions,
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
      expect(session.usage.fastestResponseMs).toBe(Infinity);
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

  describe("recordUsage with model pricing", () => {
    it("applies haiku pricing for haiku model", () => {
      const chatId = "test-haiku-pricing";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        model: "claude-haiku-4-5",
      });
      // Haiku input: $0.8/M
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(0.8, 1);
    });

    it("applies opus pricing for opus model", () => {
      const chatId = "test-opus-pricing";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        model: "claude-opus-4-6",
      });
      // Opus input: $15/M
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(15, 1);
    });

    it("applies sonnet pricing by default (no model)", () => {
      const chatId = "test-sonnet-pricing-default";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // Sonnet input: $3/M
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(3, 1);
    });

    it("calculates output cost correctly", () => {
      const chatId = "test-output-cost";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        model: "claude-sonnet-4-6",
      });
      // Sonnet output: $15/M
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(15, 1);
    });

    it("calculates cache read cost correctly", () => {
      const chatId = "test-cache-read-cost";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 1_000_000,
        cacheWrite: 0,
        model: "claude-sonnet-4-6",
      });
      // Sonnet cacheRead: $0.3/M
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(0.3, 2);
    });

    it("calculates cache write cost correctly", () => {
      const chatId = "test-cache-write-cost";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 1_000_000,
        model: "claude-sonnet-4-6",
      });
      // Sonnet cacheWrite: $3.75/M
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(3.75, 2);
    });

    it("tracks lastModel", () => {
      const chatId = "test-last-model";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        model: "claude-opus-4-6",
      });

      expect(getSession(chatId).lastModel).toBe("claude-opus-4-6");
    });

    it("updates fastestResponseMs correctly across turns", () => {
      const chatId = "test-fastest-response";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        durationMs: 2000,
      });

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        durationMs: 500,
      });

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 0,
        cacheWrite: 0,
        durationMs: 1000,
      });

      const usage = getSession(chatId).usage;
      expect(usage.fastestResponseMs).toBe(500);
      expect(usage.lastResponseMs).toBe(1000);
      expect(usage.totalResponseMs).toBe(3500);
    });
  });

  describe("setSessionName", () => {
    it("persists session name", () => {
      const chatId = "test-set-name";
      getSession(chatId);
      setSessionName(chatId, "My Test Session");
      expect(getSession(chatId).sessionName).toBe("My Test Session");
    });

    it("updates existing name", () => {
      const chatId = "test-update-name";
      getSession(chatId);
      setSessionName(chatId, "First Name");
      setSessionName(chatId, "Second Name");
      expect(getSession(chatId).sessionName).toBe("Second Name");
    });

    it("is reflected in getSessionInfo", () => {
      const chatId = "test-name-in-info";
      setSessionId(chatId, "sid-name");
      setSessionName(chatId, "Named Session");
      const info = getSessionInfo(chatId);
      expect(info.sessionName).toBe("Named Session");
    });
  });

  describe("setLastBotMessageId", () => {
    it("persists bot message ID", () => {
      const chatId = "test-set-bot-msg-id";
      getSession(chatId);
      setLastBotMessageId(chatId, 999);
      expect(getLastBotMessageId(chatId)).toBe(999);
    });

    it("updates existing bot message ID", () => {
      const chatId = "test-update-bot-msg";
      getSession(chatId);
      setLastBotMessageId(chatId, 100);
      setLastBotMessageId(chatId, 200);
      expect(getLastBotMessageId(chatId)).toBe(200);
    });
  });

  describe("getAllSessions", () => {
    it("returns all active sessions", () => {
      const id1 = "test-all-sessions-1";
      const id2 = "test-all-sessions-2";
      getSession(id1);
      getSession(id2);
      setSessionId(id1, "sid-1");
      setSessionId(id2, "sid-2");

      const all = getAllSessions();
      const chatIds = all.map((s) => s.chatId);
      expect(chatIds).toContain(id1);
      expect(chatIds).toContain(id2);
    });

    it("returns correct info structure for each session", () => {
      const id = "test-all-sessions-info";
      setSessionId(id, "sid-info");
      incrementTurns(id);

      const all = getAllSessions();
      const entry = all.find((s) => s.chatId === id);
      expect(entry).toBeDefined();
      expect(entry!.info.sessionId).toBe("sid-info");
      expect(entry!.info.turns).toBe(1);
      expect(entry!.info.usage).toBeDefined();
      expect(entry!.info.usage.totalInputTokens).toBe(0);
    });
  });

  describe("loadSessions", () => {
    it("handles missing file gracefully", () => {
      vi.mocked(existsSync).mockReturnValueOnce(false);
      expect(() => loadSessions()).not.toThrow();
    });

    it("handles corrupt JSON gracefully", () => {
      vi.mocked(existsSync).mockReturnValueOnce(true);
      vi.mocked(readFileSync).mockReturnValueOnce("not valid json");
      expect(() => loadSessions()).not.toThrow();
    });
  });

  describe("flushSessions", () => {
    it("triggers an atomic write", () => {
      writeFileAtomicSync.mockClear();
      flushSessions();
      expect(writeFileAtomicSync).toHaveBeenCalled();
    });
  });

  describe("cost calculation math", () => {
    it("calculates multi-component cost correctly (input + output + cache)", () => {
      const chatId = "test-cost-math";
      getSession(chatId);

      // Use exact token counts to verify the formula:
      // cost = (input * pricing.input + cacheWrite * pricing.cacheWrite +
      //         cacheRead * pricing.cacheRead + output * pricing.output) / 1_000_000
      // Sonnet: input=$3/M, output=$15/M, cacheRead=$0.3/M, cacheWrite=$3.75/M
      recordUsage(chatId, {
        inputTokens: 500_000,   // 500k * 3 / 1M = $1.50
        outputTokens: 100_000,  // 100k * 15 / 1M = $1.50
        cacheRead: 200_000,     // 200k * 0.3 / 1M = $0.06
        cacheWrite: 100_000,    // 100k * 3.75 / 1M = $0.375
        model: "claude-sonnet-4-6",
      });

      const usage = getSession(chatId).usage;
      // Total: 1.50 + 1.50 + 0.06 + 0.375 = $3.435
      expect(usage.estimatedCostUsd).toBeCloseTo(3.435, 3);
    });

    it("accumulates cost across multiple recordUsage calls", () => {
      const chatId = "test-cost-accum";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // Sonnet input: $3
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(3, 2);

      recordUsage(chatId, {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
      });
      // + Sonnet output: $15. Total: $18
      expect(getSession(chatId).usage.estimatedCostUsd).toBeCloseTo(18, 2);
    });
  });

  describe("cache hit rate tracking", () => {
    it("tracks cache read tokens across multiple turns", () => {
      const chatId = "test-cache-track-read";
      getSession(chatId);

      recordUsage(chatId, {
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 500,
        cacheWrite: 200,
      });
      recordUsage(chatId, {
        inputTokens: 150,
        outputTokens: 75,
        cacheRead: 800,
        cacheWrite: 100,
      });

      const usage = getSession(chatId).usage;
      expect(usage.totalCacheRead).toBe(1300);
      expect(usage.totalCacheWrite).toBe(300);
    });
  });

  describe("resetSession clears state", () => {
    it("after reset, sessionId is undefined and turns is 0", () => {
      const chatId = "test-reset-clear";
      setSessionId(chatId, "some-session");
      incrementTurns(chatId);
      incrementTurns(chatId);
      incrementTurns(chatId);

      expect(getSession(chatId).sessionId).toBe("some-session");
      expect(getSession(chatId).turns).toBe(3);

      resetSession(chatId);

      // getSession creates a fresh session, so check defaults
      const fresh = getSession(chatId);
      expect(fresh.sessionId).toBeUndefined();
      expect(fresh.turns).toBe(0);
      expect(fresh.usage.estimatedCostUsd).toBe(0);
      expect(fresh.usage.totalInputTokens).toBe(0);
    });
  });

  describe("getActiveSessionCount", () => {
    it("returns the number of tracked sessions", () => {
      // Create a session so count is at least 1
      getSession("test-count-session");
      const count = getActiveSessionCount();
      expect(count).toBeGreaterThan(0);
      expect(typeof count).toBe("number");
    });

    it("increases when new sessions are created", () => {
      const before = getActiveSessionCount();
      getSession("test-count-new-" + Math.random());
      expect(getActiveSessionCount()).toBe(before + 1);
    });
  });
});
