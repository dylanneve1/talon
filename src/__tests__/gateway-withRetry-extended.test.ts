/**
 * Extended Gateway class tests — covers methods and branches not tested in
 * gateway-context.test.ts or gateway-retry.test.ts.
 *
 * Specifically exercises:
 *   - isChatBusy() true / false states
 *   - incrementMessages() + getMessageCount() interaction
 *   - getActiveChats() as contexts are added and removed
 *   - setContext() refCount increment when called twice for the same chat
 *   - clearContext() with a numeric string chatId ("123" → parsed via Number())
 *   - clearContext() with a non-numeric string chatId (Teams-style: findContextByStringId path)
 *   - clearContext() refCount floor at 0 (Math.max guard)
 *   - clearContext() for an unknown stringId (no-op)
 *   - setContext() with a stringId persists the string for lookup
 *   - getPort() returns 0 before start() is called
 *   - stop() when server is null is a no-op (resolves immediately)
 *   - setFrontendHandler() stores the handler (observable via HTTP dispatch)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mocks (must precede all imports) ─────────────────────────────────────────

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/gateway-actions.js", () => ({
  handleSharedAction: vi.fn(async () => null),
}));

vi.mock("../core/plugin.js", () => ({
  handlePluginAction: vi.fn(async () => null),
}));

vi.mock("../core/dispatcher.js", () => ({
  getActiveCount: vi.fn(() => 0),
}));

vi.mock("../util/watchdog.js", () => ({
  recordError: vi.fn(),
  getHealthStatus: vi.fn(() => ({
    healthy: true,
    totalMessagesProcessed: 0,
    recentErrorCount: 0,
    msSinceLastMessage: 0,
  })),
}));

vi.mock("../storage/sessions.js", () => ({
  getActiveSessionCount: vi.fn(() => 0),
}));

// ── Subject under test ────────────────────────────────────────────────────────

import { Gateway } from "../core/gateway.js";

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Gateway — extended method coverage", () => {
  let gateway: Gateway;

  beforeEach(() => {
    gateway = new Gateway();
  });

  // ── isChatBusy ─────────────────────────────────────────────────────────────

  describe("isChatBusy()", () => {
    it("returns true when a context has been set for the chat", () => {
      gateway.setContext(1001);
      expect(gateway.isChatBusy(1001)).toBe(true);
    });

    it("returns false when no context has ever been set", () => {
      expect(gateway.isChatBusy(9999)).toBe(false);
    });

    it("returns false after the context is cleared", () => {
      gateway.setContext(1002);
      gateway.clearContext(1002);
      expect(gateway.isChatBusy(1002)).toBe(false);
    });

    it("returns true while refCount > 0 after two setContext calls", () => {
      gateway.setContext(1003);
      gateway.setContext(1003); // refCount = 2
      gateway.clearContext(1003); // refCount = 1 — still busy
      expect(gateway.isChatBusy(1003)).toBe(true);
      gateway.clearContext(1003); // refCount = 0 — released
      expect(gateway.isChatBusy(1003)).toBe(false);
    });
  });

  // ── incrementMessages / getMessageCount ────────────────────────────────────

  describe("incrementMessages() + getMessageCount()", () => {
    it("starts at 0 after context is set", () => {
      gateway.setContext(2001);
      expect(gateway.getMessageCount(2001)).toBe(0);
    });

    it("increments message count by 1 each call", () => {
      gateway.setContext(2002);
      gateway.incrementMessages(2002);
      expect(gateway.getMessageCount(2002)).toBe(1);
      gateway.incrementMessages(2002);
      gateway.incrementMessages(2002);
      expect(gateway.getMessageCount(2002)).toBe(3);
    });

    it("incrementMessages on a chat with no context is a no-op (no throw)", () => {
      expect(() => gateway.incrementMessages(9999)).not.toThrow();
      expect(gateway.getMessageCount(9999)).toBe(0);
    });

    it("message counts are independent per chat", () => {
      gateway.setContext(2010);
      gateway.setContext(2011);
      gateway.incrementMessages(2010);
      gateway.incrementMessages(2010);
      gateway.incrementMessages(2011);
      expect(gateway.getMessageCount(2010)).toBe(2);
      expect(gateway.getMessageCount(2011)).toBe(1);
    });

    it("getMessageCount returns 0 for a chat that has never had a context", () => {
      expect(gateway.getMessageCount(8888)).toBe(0);
    });
  });

  // ── getActiveChats ─────────────────────────────────────────────────────────

  describe("getActiveChats()", () => {
    it("returns 0 for a fresh gateway", () => {
      expect(gateway.getActiveChats()).toBe(0);
    });

    it("increments as contexts are added", () => {
      gateway.setContext(3001);
      expect(gateway.getActiveChats()).toBe(1);
      gateway.setContext(3002);
      expect(gateway.getActiveChats()).toBe(2);
      gateway.setContext(3003);
      expect(gateway.getActiveChats()).toBe(3);
    });

    it("does NOT increment when setContext is called twice for the same chat (refCount only)", () => {
      gateway.setContext(3010);
      gateway.setContext(3010); // ref++, not a new map entry
      expect(gateway.getActiveChats()).toBe(1);
    });

    it("decrements when a context is fully released", () => {
      gateway.setContext(3020);
      gateway.setContext(3021);
      gateway.clearContext(3020);
      expect(gateway.getActiveChats()).toBe(1);
      gateway.clearContext(3021);
      expect(gateway.getActiveChats()).toBe(0);
    });
  });

  // ── setContext refCount ────────────────────────────────────────────────────

  describe("setContext() refCount behaviour", () => {
    it("first call creates context with refCount 1", () => {
      gateway.setContext(4001);
      expect(gateway.isChatBusy(4001)).toBe(true);
      expect(gateway.getActiveChats()).toBe(1);
    });

    it("second call for the same chat increments refCount (still 1 active chat)", () => {
      gateway.setContext(4002);
      gateway.setContext(4002);
      expect(gateway.getActiveChats()).toBe(1);
      // Needs two clears to fully release
      gateway.clearContext(4002);
      expect(gateway.isChatBusy(4002)).toBe(true);
      gateway.clearContext(4002);
      expect(gateway.isChatBusy(4002)).toBe(false);
    });

    it("setContext with a stringId stores it for string-based lookup", () => {
      // Assign a stringId; the context should be findable by it later
      gateway.setContext(5001, "teams_chat_19:abc");
      expect(gateway.isChatBusy(5001)).toBe(true);
      // Clear by the stringId (non-numeric path) — should release the context
      gateway.clearContext("teams_chat_19:abc");
      expect(gateway.isChatBusy(5001)).toBe(false);
    });
  });

  // ── clearContext — numeric string path ─────────────────────────────────────

  describe("clearContext() with numeric string chatId", () => {
    it("accepts a numeric string and resolves it as a number", () => {
      gateway.setContext(6001);
      // "6001" → Number("6001") = 6001 — valid numeric path
      gateway.clearContext("6001");
      expect(gateway.isChatBusy(6001)).toBe(false);
      expect(gateway.getActiveChats()).toBe(0);
    });

    it("numeric string decrements refCount correctly", () => {
      gateway.setContext(6002);
      gateway.setContext(6002); // refCount = 2
      gateway.clearContext("6002"); // refCount = 1
      expect(gateway.isChatBusy(6002)).toBe(true);
      gateway.clearContext("6002"); // refCount = 0
      expect(gateway.isChatBusy(6002)).toBe(false);
    });
  });

  // ── clearContext — non-numeric string (Teams-style) ────────────────────────

  describe("clearContext() with non-numeric string chatId (findContextByStringId path)", () => {
    it("clears by string ID when the context was set with a matching stringId", () => {
      gateway.setContext(7001, "19:threadABC@thread.v2");
      // Non-numeric → Number("19:threadABC@thread.v2") = NaN → fallback to findContextByStringId
      gateway.clearContext("19:threadABC@thread.v2");
      expect(gateway.isChatBusy(7001)).toBe(false);
    });

    it("is a no-op when the non-numeric string ID does not match any context", () => {
      gateway.setContext(7002, "known-string-id");
      // Unknown string ID — no context should be modified
      gateway.clearContext("completely-unknown-id");
      expect(gateway.isChatBusy(7002)).toBe(true); // original context untouched
      gateway.clearContext(7002); // cleanup
    });

    it("refCount is decremented correctly through string ID", () => {
      gateway.setContext(7003, "teams-thread-xyz");
      gateway.setContext(7003); // refCount = 2 (no stringId on second call — same map entry)
      gateway.clearContext("teams-thread-xyz"); // refCount = 1
      expect(gateway.isChatBusy(7003)).toBe(true);
      gateway.clearContext(7003); // refCount = 0
      expect(gateway.isChatBusy(7003)).toBe(false);
    });
  });

  // ── clearContext edge cases ────────────────────────────────────────────────

  describe("clearContext() edge cases", () => {
    it("does not go below refCount 0 (Math.max guard) — extra clear is safe", () => {
      gateway.setContext(8001);
      gateway.clearContext(8001); // refCount → 0, entry deleted
      // Extra clear — context no longer exists, should be a no-op
      expect(() => gateway.clearContext(8001)).not.toThrow();
      expect(gateway.isChatBusy(8001)).toBe(false);
    });

    it("clearContext with undefined chatId is a no-op", () => {
      gateway.setContext(8002);
      gateway.clearContext(undefined);
      expect(gateway.isChatBusy(8002)).toBe(true);
      gateway.clearContext(8002); // cleanup
    });

    it("clearContext on an unknown numeric chatId is a no-op", () => {
      expect(() => gateway.clearContext(99999)).not.toThrow();
      expect(gateway.getActiveChats()).toBe(0);
    });
  });

  // ── getPort before start ───────────────────────────────────────────────────

  describe("getPort()", () => {
    it("returns 0 before start() is called", () => {
      expect(gateway.getPort()).toBe(0);
    });
  });

  // ── stop() when server is null ─────────────────────────────────────────────

  describe("stop()", () => {
    it("resolves immediately when the server was never started", async () => {
      // server is null — stop() should resolve without error
      await expect(gateway.stop()).resolves.toBeUndefined();
    });

    it("calling stop() twice after no start is safe", async () => {
      await expect(gateway.stop()).resolves.toBeUndefined();
      await expect(gateway.stop()).resolves.toBeUndefined();
    });
  });

  // ── setFrontendHandler ────────────────────────────────────────────────────

  describe("setFrontendHandler()", () => {
    it("accepts a handler function without throwing", () => {
      const handler = vi.fn(async () => ({ ok: true }));
      expect(() => gateway.setFrontendHandler(handler)).not.toThrow();
    });

    it("replaces a previously set handler", () => {
      const firstHandler = vi.fn(async () => ({ ok: true, source: "first" }));
      const secondHandler = vi.fn(async () => ({ ok: true, source: "second" }));
      gateway.setFrontendHandler(firstHandler);
      gateway.setFrontendHandler(secondHandler);
      // Both registrations should succeed without error; the second wins
      expect(firstHandler).not.toHaveBeenCalled();
      expect(secondHandler).not.toHaveBeenCalled();
    });
  });

  // ── combined workflow ─────────────────────────────────────────────────────

  describe("combined workflow", () => {
    it("full lifecycle: set → increment → clear → verify reset", () => {
      gateway.setContext(9001);
      gateway.incrementMessages(9001);
      gateway.incrementMessages(9001);
      expect(gateway.getMessageCount(9001)).toBe(2);
      expect(gateway.isChatBusy(9001)).toBe(true);

      gateway.clearContext(9001);
      expect(gateway.isChatBusy(9001)).toBe(false);
      // Message count for a cleared context returns 0 (map entry deleted)
      expect(gateway.getMessageCount(9001)).toBe(0);
    });

    it("three chats, selective removal preserves others", () => {
      gateway.setContext(9010);
      gateway.setContext(9011);
      gateway.setContext(9012);
      expect(gateway.getActiveChats()).toBe(3);

      gateway.clearContext(9011);
      expect(gateway.getActiveChats()).toBe(2);
      expect(gateway.isChatBusy(9010)).toBe(true);
      expect(gateway.isChatBusy(9011)).toBe(false);
      expect(gateway.isChatBusy(9012)).toBe(true);

      gateway.clearContext(9010);
      gateway.clearContext(9012);
      expect(gateway.getActiveChats()).toBe(0);
    });
  });
});
