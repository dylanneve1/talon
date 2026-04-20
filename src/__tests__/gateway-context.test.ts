import { describe, it, expect, beforeEach, vi } from "vitest";

// Gateway statically imports setLogLevel/getLogLevel/getRecentLogs from
// log.js for the /debug/* routes. ESM resolution throws on any missing
// export even when the test doesn't exercise that path, so expose them
// defensively alongside the legacy wrappers.
vi.mock("../util/log.js", () => {
  let currentLevel = "trace";
  return {
    log: vi.fn(),
    logError: vi.fn(),
    logWarn: vi.fn(),
    logDebug: vi.fn(),
    setLogLevel: vi.fn((lvl: string) => {
      currentLevel = lvl;
    }),
    getLogLevel: vi.fn(() => currentLevel),
    getRecentLogs: vi.fn(() => []),
  };
});

vi.mock("../core/gateway-actions.js", () => ({
  handleSharedAction: vi.fn(async () => null),
}));

import { Gateway } from "../core/gateway.js";

describe("gateway per-chat context", () => {
  let gateway: Gateway;

  beforeEach(() => {
    gateway = new Gateway();
  });

  it("sets context for a chat", () => {
    gateway.setContext(12345);
    expect(gateway.isChatBusy(12345)).toBe(true);
    expect(gateway.getActiveChats()).toBe(1);
  });

  it("returns false for unknown chat", () => {
    expect(gateway.isChatBusy(99999)).toBe(false);
  });

  it("clears context on release", () => {
    gateway.setContext(200);
    gateway.clearContext(200);
    expect(gateway.isChatBusy(200)).toBe(false);
    expect(gateway.getActiveChats()).toBe(0);
  });

  it("ref counting: same chat twice needs two clears", () => {
    gateway.setContext(300);
    gateway.setContext(300); // ref++

    gateway.clearContext(300);
    expect(gateway.isChatBusy(300)).toBe(true); // still active

    gateway.clearContext(300);
    expect(gateway.isChatBusy(300)).toBe(false); // now released
  });

  it("multiple chats can be active simultaneously", () => {
    gateway.setContext(100);
    gateway.setContext(200);
    gateway.setContext(300);

    expect(gateway.isChatBusy(100)).toBe(true);
    expect(gateway.isChatBusy(200)).toBe(true);
    expect(gateway.isChatBusy(300)).toBe(true);
    expect(gateway.getActiveChats()).toBe(3);

    gateway.clearContext(200);
    expect(gateway.isChatBusy(100)).toBe(true);
    expect(gateway.isChatBusy(200)).toBe(false);
    expect(gateway.isChatBusy(300)).toBe(true);
    expect(gateway.getActiveChats()).toBe(2);
  });

  it("message count is per-chat", () => {
    gateway.setContext(500);
    gateway.setContext(600);

    expect(gateway.getMessageCount(500)).toBe(0);
    expect(gateway.getMessageCount(600)).toBe(0);

    gateway.incrementMessages(500);
    gateway.incrementMessages(500);
    gateway.incrementMessages(600);

    expect(gateway.getMessageCount(500)).toBe(2);
    expect(gateway.getMessageCount(600)).toBe(1);
  });

  it("message count resets when context is released and re-acquired", () => {
    gateway.setContext(700);
    gateway.incrementMessages(700);
    expect(gateway.getMessageCount(700)).toBe(1);

    gateway.clearContext(700);
    gateway.setContext(700);
    expect(gateway.getMessageCount(700)).toBe(0);
  });

  it("message count returns 0 for unknown chat", () => {
    expect(gateway.getMessageCount(99999)).toBe(0);
  });

  it("clearContext with no chatId does nothing", () => {
    gateway.setContext(800);
    gateway.clearContext();
    expect(gateway.isChatBusy(800)).toBe(true);
  });
});
