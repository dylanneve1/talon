import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the log module
vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

// Mock the actions module (not needed for context tests)
vi.mock("../frontend/telegram/bridge/actions.js", () => ({
  handleAction: vi.fn(),
}));

// Mock formatting
vi.mock("../frontend/telegram/formatting.js", () => ({
  markdownToTelegramHtml: vi.fn((s: string) => s),
}));

const {
  setBridgeContext,
  clearBridgeContext,
  isBridgeBusy,
  getBridgeMessageCount,
  getActiveChatId,
} = await import("../frontend/telegram/bridge/server.js");

/** Minimal fake Bot object (only needs to satisfy the type for context ops). */
function fakeBot(): any {
  return { api: { sendMessage: vi.fn() } };
}

/** Minimal fake InputFile class. */
function fakeInputFile(): any {
  return class {};
}

describe("bridge-context", () => {
  beforeEach(() => {
    // Ensure bridge is unlocked between tests by clearing with no owner check
    // Clear any leftover state — call clearBridgeContext enough times to fully release
    for (let i = 0; i < 10; i++) {
      clearBridgeContext();
    }
  });

  describe("setBridgeContext", () => {
    it("sets activeChatId and locks bridge", () => {
      setBridgeContext(12345, fakeBot(), fakeInputFile());
      expect(isBridgeBusy()).toBe(true);
      expect(getActiveChatId()).toBe(12345);
    });
  });

  describe("isBridgeBusy", () => {
    it("returns false when no context is set", () => {
      expect(isBridgeBusy()).toBe(false);
    });

    it("returns true when context is set", () => {
      setBridgeContext(100, fakeBot(), fakeInputFile());
      expect(isBridgeBusy()).toBe(true);
    });
  });

  describe("clearBridgeContext", () => {
    it("unlocks bridge when ref count reaches 0", () => {
      setBridgeContext(200, fakeBot(), fakeInputFile());
      expect(isBridgeBusy()).toBe(true);

      clearBridgeContext(200);
      expect(isBridgeBusy()).toBe(false);
      expect(getActiveChatId()).toBeNull();
    });
  });

  describe("ref counting", () => {
    it("same chat setBridge twice increments refCount", () => {
      const bot = fakeBot();
      const inputFile = fakeInputFile();

      setBridgeContext(300, bot, inputFile);
      expect(isBridgeBusy()).toBe(true);

      // Same chatId → bumps ref count to 2
      setBridgeContext(300, bot, inputFile);
      expect(isBridgeBusy()).toBe(true);

      // First clear decrements ref count but doesn't release
      clearBridgeContext(300);
      expect(isBridgeBusy()).toBe(true);
      expect(getActiveChatId()).toBe(300);

      // Second clear releases
      clearBridgeContext(300);
      expect(isBridgeBusy()).toBe(false);
      expect(getActiveChatId()).toBeNull();
    });
  });

  describe("ownership", () => {
    it("clear with wrong chatId is a no-op", () => {
      setBridgeContext(400, fakeBot(), fakeInputFile());
      expect(isBridgeBusy()).toBe(true);

      // Try to clear with a different chatId
      clearBridgeContext(999);
      // Should still be locked — wrong owner
      expect(isBridgeBusy()).toBe(true);
      expect(getActiveChatId()).toBe(400);
    });
  });

  describe("getBridgeMessageCount", () => {
    it("returns 0 after context is set (reset on new context)", () => {
      setBridgeContext(500, fakeBot(), fakeInputFile());
      expect(getBridgeMessageCount()).toBe(0);
    });

    it("returns 0 after context is cleared", () => {
      setBridgeContext(600, fakeBot(), fakeInputFile());
      clearBridgeContext(600);
      expect(getBridgeMessageCount()).toBe(0);
    });
  });

  describe("context replacement", () => {
    it("setting context for different chat replaces previous context", () => {
      setBridgeContext(700, fakeBot(), fakeInputFile());
      expect(getActiveChatId()).toBe(700);

      // Different chat ID → replaces context, resets ref count to 1
      setBridgeContext(800, fakeBot(), fakeInputFile());
      expect(getActiveChatId()).toBe(800);
      expect(isBridgeBusy()).toBe(true);

      // Single clear should release since ref count is 1
      clearBridgeContext(800);
      expect(isBridgeBusy()).toBe(false);
    });
  });
});
