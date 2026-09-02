/**
 * The access-gate primitives shared by the chat frontends — the sliding
 * window rate limiter, the bounded first-seen DM tracker, and the notice
 * cooldown. Behaviour-level: these used to be two copies each in
 * telegram/ and discord/ and the handler suites still cover them through
 * the message pipeline; this pins the contract of the one implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../storage/daily-log.js", () => ({ appendDailyLog: vi.fn() }));

const { createRateLimiter, createDmUserTracker, createNoticeCooldown } =
  await import("../frontend/shared/access.js");
const { log } = await import("../util/log.js");
const { appendDailyLog } = await import("../storage/daily-log.js");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-02T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("createRateLimiter", () => {
  it("admits up to maxMessages inside the window, then limits", () => {
    const limiter = createRateLimiter<number>({
      windowMs: 60_000,
      maxMessages: 3,
    });
    expect(limiter.isLimited(1)).toBe(false);
    expect(limiter.isLimited(1)).toBe(false);
    expect(limiter.isLimited(1)).toBe(false);
    expect(limiter.isLimited(1)).toBe(true);
    // Other senders are independent.
    expect(limiter.isLimited(2)).toBe(false);
  });

  it("a limited message is not recorded, so the sender recovers as the oldest ages out", () => {
    const limiter = createRateLimiter<string>({
      windowMs: 60_000,
      maxMessages: 2,
    });
    limiter.isLimited("a");
    vi.advanceTimersByTime(30_000);
    limiter.isLimited("a");
    expect(limiter.isLimited("a")).toBe(true);
    // 31s later the first timestamp is outside the window; one slot frees.
    vi.advanceTimersByTime(31_000);
    expect(limiter.isLimited("a")).toBe(false);
    expect(limiter.isLimited("a")).toBe(true);
  });

  it("evicts stale senders once the map grows past evictAbove", () => {
    const limiter = createRateLimiter<number>({
      windowMs: 60_000,
      maxMessages: 15,
      evictAbove: 5,
      evictTo: 2,
      staleAfterMs: 10 * 60_000,
    });
    for (let i = 1; i <= 5; i++) limiter.isLimited(i);
    // Eleven minutes on, a sixth sender pushes the map over the threshold;
    // the five idle senders are stale and get swept down to evictTo.
    vi.advanceTimersByTime(11 * 60_000);
    expect(limiter.isLimited(6)).toBe(false);
    // Sender 1's window is empty again, so it is admitted a full 15 times:
    // proof its old entry (and timestamps) went away rather than lingering.
    for (let i = 0; i < 15; i++) expect(limiter.isLimited(1)).toBe(false);
    expect(limiter.isLimited(1)).toBe(true);
  });
});

describe("createDmUserTracker", () => {
  it("logs a sender once, with the tag in parentheses when given", () => {
    const tracker = createDmUserTracker<number>(100);
    tracker.track(7, "Ada", "@ada");
    tracker.track(7, "Ada", "@ada");
    tracker.track(8, "Bob");
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(
      1,
      "users",
      "New DM user: Ada (@ada) [id:7]",
    );
    expect(log).toHaveBeenNthCalledWith(2, "users", "New DM user: Bob [id:8]");
    expect(appendDailyLog).toHaveBeenCalledWith(
      "System",
      "New DM user: Ada (@ada) [id:7]",
    );
  });

  it("evicts the oldest 10% at the cap, so the earliest sender is logged again", () => {
    const tracker = createDmUserTracker<number>(10);
    for (let i = 1; i <= 10; i++) tracker.track(i, `u${i}`);
    expect(log).toHaveBeenCalledTimes(10);
    // Cap reached: the 11th sender evicts sender 1 (oldest 10% = 1 entry).
    tracker.track(11, "u11");
    tracker.track(2, "u2"); // still remembered
    tracker.track(1, "u1"); // forgotten → logged again
    expect(log).toHaveBeenCalledTimes(12);
  });
});

describe("createNoticeCooldown", () => {
  it("fires once per key per ttl", () => {
    const cooldown = createNoticeCooldown({ ttlMs: 10 * 60_000, cap: 100 });
    expect(cooldown.shouldNotify("dm:1")).toBe(true);
    expect(cooldown.shouldNotify("dm:1")).toBe(false);
    expect(cooldown.shouldNotify("dm:2")).toBe(true);
    vi.advanceTimersByTime(10 * 60_000);
    expect(cooldown.shouldNotify("dm:1")).toBe(true);
  });

  it("clears everything at the cap rather than growing without bound", () => {
    const cooldown = createNoticeCooldown({ ttlMs: 60_000, cap: 2 });
    cooldown.shouldNotify("a");
    cooldown.shouldNotify("b");
    // Third distinct key hits the cap: the map is cleared, so "a" fires
    // again immediately — the documented worst case.
    expect(cooldown.shouldNotify("c")).toBe(true);
    expect(cooldown.shouldNotify("a")).toBe(true);
  });
});
