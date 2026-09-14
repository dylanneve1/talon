/**
 * Boot-time reconciliation of per-chat backend/model overrides — the loop
 * that used to run serially inside initBackendAndDispatcher. Chats are
 * independent, so it runs bounded-concurrent; the pool dedupes inits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileChatBindings } from "../bootstrap.js";
import {
  getAllChatSettings,
  loadChatSettings,
  setChatBackend,
  setChatModel,
} from "../storage/chat-settings.js";
import { stubBackend } from "./helpers/stub-backend.js";
import type { TalonConfig } from "../util/config.js";

const config = {} as TalonConfig;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deps(
  overrides: Partial<Parameters<typeof reconcileChatBindings>[1]> = {},
) {
  return {
    isBackendAvailable: vi.fn(() => true),
    releaseChat: vi.fn(async () => {}),
    rebindChat: vi.fn(async () => ({ ok: true })),
    getBackendIdForChat: vi.fn(() => "claude"),
    getBackendForChat: vi.fn(() => stubBackend()),
    isModelValidForBackend: vi.fn(async () => true),
    ...overrides,
  };
}

beforeEach(() => {
  loadChatSettings();
  for (const cid of Object.keys(getAllChatSettings())) {
    setChatBackend(cid, undefined);
    setChatModel(cid, undefined);
  }
});

describe("reconcileChatBindings", () => {
  it("rebinds every chat with an override, several at a time", async () => {
    for (let i = 0; i < 12; i++) setChatBackend(`chat-${i}`, "claude");
    let inFlight = 0;
    let peak = 0;
    const d = deps({
      rebindChat: vi.fn(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight--;
        return { ok: true };
      }),
    });
    await reconcileChatBindings(config, d);
    expect(d.rebindChat).toHaveBeenCalledTimes(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it("resets a chat whose backend is gone and clears its model", async () => {
    setChatBackend("gone", "vanished");
    setChatModel("gone", "some-model");
    const d = deps({ isBackendAvailable: vi.fn(() => false) });
    await reconcileChatBindings(config, d);
    expect(d.releaseChat).toHaveBeenCalledWith("gone");
    expect(getAllChatSettings().gone?.backend).toBeUndefined();
    expect(getAllChatSettings().gone?.model).toBeUndefined();
  });

  it("drops a stored model the bound backend no longer serves", async () => {
    setChatBackend("stale", "claude");
    setChatModel("stale", "retired-model");
    const d = deps({ isModelValidForBackend: vi.fn(async () => false) });
    await reconcileChatBindings(config, d);
    expect(getAllChatSettings().stale?.model).toBeUndefined();
  });

  it("keeps the setting when a rebind fails twice", async () => {
    vi.useFakeTimers();
    try {
      setChatBackend("flaky", "claude");
      const d = deps({
        rebindChat: vi.fn(async () => ({ ok: false, error: "boom" })),
      });
      const run = reconcileChatBindings(config, d);
      await vi.advanceTimersByTimeAsync(2_000);
      await run;
      expect(d.rebindChat).toHaveBeenCalledTimes(2);
      expect(getAllChatSettings().flaky?.backend).toBe("claude");
    } finally {
      vi.useRealTimers();
    }
  });
});
