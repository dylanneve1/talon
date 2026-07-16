/**
 * Turn-interrupt registry — the shared `ChatBackend.interruptChatTurn`
 * for the callback backends. Registration lifecycle, identity-guarded
 * unregistration (retry recursion safety), and the best-effort result
 * contract.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));

import {
  interruptChatTurn,
  registerTurnInterrupt,
} from "../backend/shared/turn-interrupt.js";

describe("turn-interrupt registry", () => {
  it("reports false when no turn is in flight", async () => {
    expect(await interruptChatTurn("nobody")).toBe(false);
  });

  it("invokes the registered interrupt and reports true", async () => {
    const interrupt = vi.fn(async () => {});
    const unregister = registerTurnInterrupt("chat-a", interrupt);

    expect(await interruptChatTurn("chat-a")).toBe(true);
    expect(interrupt).toHaveBeenCalledTimes(1);

    unregister();
    expect(await interruptChatTurn("chat-a")).toBe(false);
  });

  it("reports false when the interrupt itself fails", async () => {
    const unregister = registerTurnInterrupt("chat-b", () => {
      throw new Error("session gone");
    });
    expect(await interruptChatTurn("chat-b")).toBe(false);
    unregister();
  });

  it("never lets a stale unregister tear down a retry's registration", async () => {
    // A retry re-enters the handler and re-registers for the same chat;
    // the first attempt's finally must not remove the retry's entry.
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerTurnInterrupt("chat-c", first);
    const unregisterSecond = registerTurnInterrupt("chat-c", second);

    unregisterFirst(); // stale — identity mismatch, must be a no-op
    expect(await interruptChatTurn("chat-c")).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();

    unregisterSecond();
    expect(await interruptChatTurn("chat-c")).toBe(false);
  });
});
