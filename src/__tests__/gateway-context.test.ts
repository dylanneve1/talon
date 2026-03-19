import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

vi.mock("../core/gateway-actions.js", () => ({
  handleSharedAction: vi.fn(async () => null),
}));

const {
  setGatewayContext,
  clearGatewayContext,
  isChatBusy,
  getGatewayMessageCount,
  incrementMessageCount,
  getActiveChats,
} = await import("../core/gateway.js");

describe("gateway per-chat context", () => {
  beforeEach(() => {
    // Clear known test chatIds
    for (const id of [100, 200, 300, 400, 500, 600, 700, 800, 12345]) {
      clearGatewayContext(id);
      clearGatewayContext(id); // double clear in case refCount > 1
    }
  });

  it("sets context for a chat", () => {
    setGatewayContext(12345);
    expect(isChatBusy(12345)).toBe(true);
    expect(getActiveChats()).toBe(1);
  });

  it("returns false for unknown chat", () => {
    expect(isChatBusy(99999)).toBe(false);
  });

  it("clears context on release", () => {
    setGatewayContext(200);
    clearGatewayContext(200);
    expect(isChatBusy(200)).toBe(false);
    expect(getActiveChats()).toBe(0);
  });

  it("ref counting: same chat twice needs two clears", () => {
    setGatewayContext(300);
    setGatewayContext(300); // ref++

    clearGatewayContext(300);
    expect(isChatBusy(300)).toBe(true); // still active

    clearGatewayContext(300);
    expect(isChatBusy(300)).toBe(false); // now released
  });

  it("multiple chats can be active simultaneously", () => {
    setGatewayContext(100);
    setGatewayContext(200);
    setGatewayContext(300);

    expect(isChatBusy(100)).toBe(true);
    expect(isChatBusy(200)).toBe(true);
    expect(isChatBusy(300)).toBe(true);
    expect(getActiveChats()).toBe(3);

    clearGatewayContext(200);
    expect(isChatBusy(100)).toBe(true);
    expect(isChatBusy(200)).toBe(false);
    expect(isChatBusy(300)).toBe(true);
    expect(getActiveChats()).toBe(2);
  });

  it("message count is per-chat", () => {
    setGatewayContext(500);
    setGatewayContext(600);

    expect(getGatewayMessageCount(500)).toBe(0);
    expect(getGatewayMessageCount(600)).toBe(0);

    incrementMessageCount(500);
    incrementMessageCount(500);
    incrementMessageCount(600);

    expect(getGatewayMessageCount(500)).toBe(2);
    expect(getGatewayMessageCount(600)).toBe(1);
  });

  it("message count resets when context is released and re-acquired", () => {
    setGatewayContext(700);
    incrementMessageCount(700);
    expect(getGatewayMessageCount(700)).toBe(1);

    clearGatewayContext(700);
    setGatewayContext(700);
    expect(getGatewayMessageCount(700)).toBe(0);
  });

  it("message count returns 0 for unknown chat", () => {
    expect(getGatewayMessageCount(99999)).toBe(0);
  });

  it("clearGatewayContext with no chatId does nothing", () => {
    setGatewayContext(800);
    clearGatewayContext();
    expect(isChatBusy(800)).toBe(true);
  });
});
