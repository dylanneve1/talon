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
  isGatewayBusy,
  getGatewayMessageCount,
  getGatewayChatId,
} = await import("../core/gateway.js");

describe("gateway context", () => {
  beforeEach(() => {
    for (let i = 0; i < 10; i++) clearGatewayContext();
  });

  it("sets context and locks gateway", () => {
    setGatewayContext(12345);
    expect(isGatewayBusy()).toBe(true);
    expect(getGatewayChatId()).toBe(12345);
  });

  it("returns false when no context set", () => {
    expect(isGatewayBusy()).toBe(false);
  });

  it("clears context on release", () => {
    setGatewayContext(200);
    clearGatewayContext(200);
    expect(isGatewayBusy()).toBe(false);
    expect(getGatewayChatId()).toBeNull();
  });

  it("ref counting: same chat twice needs two clears", () => {
    setGatewayContext(300);
    setGatewayContext(300); // ref++

    clearGatewayContext(300);
    expect(isGatewayBusy()).toBe(true); // still locked

    clearGatewayContext(300);
    expect(isGatewayBusy()).toBe(false); // now released
  });

  it("wrong chatId clear is no-op", () => {
    setGatewayContext(400);
    clearGatewayContext(999); // wrong owner
    expect(isGatewayBusy()).toBe(true);
    expect(getGatewayChatId()).toBe(400);
  });

  it("message count resets on new context", () => {
    setGatewayContext(500);
    expect(getGatewayMessageCount()).toBe(0);
  });

  it("different chat replaces context", () => {
    setGatewayContext(700);
    setGatewayContext(800); // replaces
    expect(getGatewayChatId()).toBe(800);

    clearGatewayContext(800);
    expect(isGatewayBusy()).toBe(false);
  });
});
