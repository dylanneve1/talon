/**
 * Live-turn overlay tests — the real-time stats layer.
 *
 * Backends push mid-turn usage snapshots into a per-chat in-memory
 * overlay (`storage/sessions.ts: updateLiveTurn`); `getSessionInfo`
 * projects the persisted cumulative totals through it so /status
 * reflects the in-progress turn. The overlay is never persisted and is
 * cleared when the turn's final accounting commits (`recordUsage`) or
 * when a failed turn settles (`recordFailedTurnAccounting`).
 *
 * Covers:
 *   - overlay merge semantics (absolute so-far values, partial updates)
 *   - getSessionInfo / getAllSessions projection + turnInProgress flag
 *   - recordUsage clearing the overlay (no double-count window)
 *   - resetSession clearing the overlay
 *   - stream-state binding: recordTokens/pushLiveUsage mirror into the
 *     overlay only when the state carries a chatId
 *   - recordFailedTurnAccounting: failed turns commit their burn and
 *     always drop the overlay
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  getSession,
  getSessionInfo,
  getAllSessions,
  getLiveTurn,
  updateLiveTurn,
  clearLiveTurn,
  recordUsage,
  resetSession,
} from "../storage/sessions.js";
import {
  createStreamState,
  recordTokens,
  pushLiveUsage,
} from "../backend/shared/stream-state.js";
import { recordFailedTurnAccounting } from "../backend/shared/metrics.js";
import { getMetrics, resetMetrics } from "../util/metrics.js";

let chatN = 0;
let chatId: string;

beforeEach(() => {
  resetMetrics();
  chatId = `live-overlay-chat-${chatN++}`;
  resetSession(chatId);
});

describe("updateLiveTurn / getLiveTurn / clearLiveTurn", () => {
  it("creates the overlay on first update and merges partial updates", () => {
    updateLiveTurn(chatId, { inputTokens: 100, contextTokens: 5000 });
    updateLiveTurn(chatId, { outputTokens: 40 });

    const live = getLiveTurn(chatId);
    expect(live).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
      contextTokens: 5000,
      cacheRead: 0,
    });
    expect(live!.startedAt).toBeGreaterThan(0);
  });

  it("treats values as absolute so-far counts (replace, not add)", () => {
    updateLiveTurn(chatId, { inputTokens: 100 });
    updateLiveTurn(chatId, { inputTokens: 250 });
    expect(getLiveTurn(chatId)?.inputTokens).toBe(250);
  });

  it("clamps negative values to 0 and ignores non-finite ones", () => {
    updateLiveTurn(chatId, { inputTokens: -5, outputTokens: Number.NaN });
    expect(getLiveTurn(chatId)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("clearLiveTurn drops the overlay", () => {
    updateLiveTurn(chatId, { inputTokens: 1 });
    clearLiveTurn(chatId);
    expect(getLiveTurn(chatId)).toBeUndefined();
  });
});

describe("getSessionInfo projection", () => {
  it("adds live token counts on top of persisted totals", () => {
    recordUsage(chatId, {
      inputTokens: 1000,
      outputTokens: 200,
      cacheRead: 300,
      cacheWrite: 50,
    });
    updateLiveTurn(chatId, {
      inputTokens: 111,
      outputTokens: 22,
      cacheRead: 33,
      cacheWrite: 4,
    });

    const u = getSessionInfo(chatId).usage;
    expect(u.totalInputTokens).toBe(1111);
    expect(u.totalOutputTokens).toBe(222);
    expect(u.totalCacheRead).toBe(333);
    expect(u.totalCacheWrite).toBe(54);
  });

  it("prefers live context fill / window / api calls when present", () => {
    recordUsage(chatId, {
      inputTokens: 10,
      outputTokens: 10,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: 40_000,
      contextWindow: 200_000,
      numApiCalls: 4,
    });
    updateLiveTurn(chatId, {
      contextTokens: 95_000,
      contextWindow: 258_400,
      numApiCalls: 12,
    });

    const u = getSessionInfo(chatId).usage;
    expect(u.contextTokens).toBe(95_000);
    expect(u.contextWindow).toBe(258_400);
    expect(u.numApiCalls).toBe(12);
  });

  it("falls back to persisted context values when the overlay has none yet", () => {
    recordUsage(chatId, {
      inputTokens: 10,
      outputTokens: 10,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: 40_000,
      contextWindow: 200_000,
      numApiCalls: 4,
    });
    updateLiveTurn(chatId, { inputTokens: 5 });

    const u = getSessionInfo(chatId).usage;
    expect(u.contextTokens).toBe(40_000);
    expect(u.contextWindow).toBe(200_000);
    expect(u.numApiCalls).toBe(4);
  });

  it("sets turnInProgress while the overlay exists", () => {
    getSession(chatId);
    expect(getSessionInfo(chatId).turnInProgress).toBe(false);
    updateLiveTurn(chatId, { inputTokens: 1 });
    expect(getSessionInfo(chatId).turnInProgress).toBe(true);
    clearLiveTurn(chatId);
    expect(getSessionInfo(chatId).turnInProgress).toBe(false);
  });

  it("does not mutate the stored usage object", () => {
    recordUsage(chatId, {
      inputTokens: 100,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    updateLiveTurn(chatId, { inputTokens: 50 });
    getSessionInfo(chatId);
    expect(getSession(chatId).usage.totalInputTokens).toBe(100);
  });

  it("getAllSessions applies the same projection", () => {
    recordUsage(chatId, {
      inputTokens: 100,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    updateLiveTurn(chatId, { inputTokens: 11 });
    const entry = getAllSessions().find((s) => s.chatId === chatId);
    expect(entry?.info.usage.totalInputTokens).toBe(111);
    expect(entry?.info.turnInProgress).toBe(true);
  });
});

describe("overlay lifecycle", () => {
  it("recordUsage clears the overlay so the turn is never counted twice", () => {
    updateLiveTurn(chatId, { inputTokens: 500, outputTokens: 100 });
    recordUsage(chatId, {
      inputTokens: 500,
      outputTokens: 100,
      cacheRead: 0,
      cacheWrite: 0,
    });

    expect(getLiveTurn(chatId)).toBeUndefined();
    expect(getSessionInfo(chatId).usage.totalInputTokens).toBe(500);
  });

  it("resetSession clears the overlay", () => {
    updateLiveTurn(chatId, { inputTokens: 5 });
    resetSession(chatId);
    expect(getLiveTurn(chatId)).toBeUndefined();
  });
});

describe("stream-state binding", () => {
  it("recordTokens mirrors into the overlay when the state is chat-bound", () => {
    const state = createStreamState(chatId);
    state.contextTokens = 42_000;
    state.contextWindow = 258_400;
    state.numApiCalls = 3;
    recordTokens(state, {
      inputTokens: 1234,
      outputTokens: 56,
      cacheRead: 78,
      cacheWrite: 9,
    });

    expect(getLiveTurn(chatId)).toMatchObject({
      inputTokens: 1234,
      outputTokens: 56,
      cacheRead: 78,
      cacheWrite: 9,
      contextTokens: 42_000,
      contextWindow: 258_400,
      numApiCalls: 3,
    });
  });

  it("recordTokens stays pure when the state is unbound", () => {
    const state = createStreamState();
    recordTokens(state, { inputTokens: 999 });
    // No chat to mirror into — nothing to assert beyond "didn't throw",
    // but make sure no stray overlay appeared for the test chat.
    expect(getLiveTurn(chatId)).toBeUndefined();
  });

  it("pushLiveUsage mirrors current state explicitly (out-of-band updates)", () => {
    const state = createStreamState(chatId);
    state.sdkInputTokens = 10;
    state.contextTokens = 7000;
    pushLiveUsage(state);
    expect(getLiveTurn(chatId)).toMatchObject({
      inputTokens: 10,
      contextTokens: 7000,
    });
  });
});

describe("recordFailedTurnAccounting", () => {
  it("commits the failed turn's burn to session usage + metrics and drops the overlay", () => {
    updateLiveTurn(chatId, { inputTokens: 800 });
    recordFailedTurnAccounting({
      backend: "codex",
      chatId,
      durationMs: 1200,
      toolCalls: 2,
      apiCalls: 5,
      model: "gpt-5.5",
      usage: {
        inputTokens: 800,
        outputTokens: 90,
        cacheRead: 700,
        cacheWrite: 0,
      },
      contextTokens: 60_000,
      contextWindow: 258_400,
    });

    expect(getLiveTurn(chatId)).toBeUndefined();
    const u = getSessionInfo(chatId).usage;
    expect(u.totalInputTokens).toBe(800);
    expect(u.totalOutputTokens).toBe(90);
    expect(u.contextTokens).toBe(60_000);

    const m = getMetrics();
    expect(m.counters["backend.codex.turn_failed"]).toBe(1);
    expect(m.counters["tokens.input_total"]).toBe(800);
    expect(m.counters["queries_total"]).toBe(1);
  });

  it("zero-usage failure records the failed query but leaves session usage untouched", () => {
    recordUsage(chatId, {
      inputTokens: 100,
      outputTokens: 10,
      cacheRead: 0,
      cacheWrite: 0,
      contextTokens: 30_000,
    });
    updateLiveTurn(chatId, { inputTokens: 0 });

    recordFailedTurnAccounting({
      backend: "claude",
      chatId,
      durationMs: 300,
      usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 },
    });

    expect(getLiveTurn(chatId)).toBeUndefined();
    const u = getSessionInfo(chatId).usage;
    // No phantom usage and — critically — the context display from the
    // last good turn survives instead of being wiped to "unknown".
    expect(u.totalInputTokens).toBe(100);
    expect(u.contextTokens).toBe(30_000);
    expect(getMetrics().counters["backend.claude.turn_failed"]).toBe(1);
  });
});
