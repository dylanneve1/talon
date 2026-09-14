/**
 * Unit tests for the shared post-stream turn phases
 * (`backend/shared/turn-phases.ts`).
 *
 * Every backend handler runs these after its SDK stream loop: accounting,
 * session naming, the trailing-prose contract, and the result tail. The
 * phases are asserted here against a hand-built `StreamState` and the
 * real session store; the per-backend handler suites cover the wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("../util/trace.js", () => ({ traceMessage: vi.fn() }));

import { log } from "../util/log.js";
import { traceMessage } from "../util/trace.js";
import {
  getSession,
  getSessionInfo,
  resetSession,
  setSessionId,
} from "../storage/sessions.js";
import { resetMetrics } from "../storage/metrics.js";
import {
  accountTurn,
  accountFailedTurn,
  buildResultEvents,
  createStreamState,
  enforceTrailingProse,
  finishCallbackTurn,
  nameSessionFromFirstMessage,
  turnUsageSnapshot,
  type StreamState,
} from "../backend/shared/index.js";
import { FLOW_VIOLATION_MAX_RETRIES } from "../backend/shared/flow-violation.js";

const CHAT = "turn-phases-chat";

function makeState(overrides: Partial<StreamState> = {}): StreamState {
  const state = createStreamState();
  Object.assign(state, overrides);
  return state;
}

const logLines = (): string[] =>
  vi.mocked(log).mock.calls.map((c) => String(c[1]));

beforeEach(() => {
  resetSession(CHAT);
  resetMetrics();
  vi.clearAllMocks();
});

describe("shared / turnUsageSnapshot", () => {
  it("projects the sdk* counters into the token snapshot", () => {
    const state = makeState({
      sdkInputTokens: 10,
      sdkOutputTokens: 20,
      sdkCacheRead: 30,
      sdkCacheWrite: 40,
    });
    expect(turnUsageSnapshot(state)).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 30,
      cacheWrite: 40,
    });
  });
});

describe("shared / accountTurn", () => {
  it("folds usage, session id and per-turn metrics into the session", () => {
    const state = makeState({
      sdkInputTokens: 100,
      sdkOutputTokens: 50,
      sdkCacheRead: 25,
      sdkCacheWrite: 5,
      toolCalls: 3,
      numApiCalls: 2,
    });
    accountTurn({
      chatId: CHAT,
      backend: "codex",
      state,
      durationMs: 1234,
      model: "gpt-test",
      sessionId: "thr_1",
      context: { contextTokens: 900, contextWindow: 4000, numApiCalls: 2 },
    });

    const session = getSession(CHAT);
    expect(session.sessionId).toBe("thr_1");
    expect(session.usage.totalInputTokens).toBe(100);
    expect(session.usage.totalOutputTokens).toBe(50);
    expect(session.usage.totalCacheRead).toBe(25);
    expect(session.usage.totalCacheWrite).toBe(5);
    expect(session.usage.contextTokens).toBe(900);
    expect(session.usage.contextWindow).toBe(4000);
    expect(session.usage.numApiCalls).toBe(2);
    expect(session.usage.lastResponseMs).toBe(1234);
    expect(session.lastModel).toBe("gpt-test");
    expect(session.metrics.lifetime.counters.queries).toBe(1);
    expect(session.metrics.lifetime.backend.codex?.queries).toBe(1);
    expect(session.metrics.lifetime.counters.turnsWithTools).toBe(1);
    expect(session.metrics.lifetime.toolCallsPerTurn.maxMs).toBe(3);
  });

  it("prefers an explicit toolCalls override for the metric rollup", () => {
    const state = makeState({ toolCalls: 1 });
    accountTurn({
      chatId: CHAT,
      backend: "codex",
      state,
      durationMs: 1,
      model: "m",
      toolCalls: 7,
    });
    expect(getSession(CHAT).metrics.lifetime.toolCallsPerTurn.maxMs).toBe(7);
  });

  it("leaves the stored session id alone when unchanged or absent", () => {
    setSessionId(CHAT, "keep-me");
    const state = makeState();
    accountTurn({
      chatId: CHAT,
      backend: "kilo",
      state,
      durationMs: 1,
      model: "m",
    });
    expect(getSession(CHAT).sessionId).toBe("keep-me");
    accountTurn({
      chatId: CHAT,
      backend: "kilo",
      state,
      durationMs: 1,
      model: "m",
      sessionId: "keep-me",
    });
    expect(getSession(CHAT).sessionId).toBe("keep-me");
  });

  it("clears the live-turn overlay once the turn is committed", () => {
    const state = makeState({ chatId: CHAT });
    // Bind the state to the chat so the token mutator paints the overlay.
    state.sdkInputTokens = 5;
    accountTurn({
      chatId: CHAT,
      backend: "claude",
      state,
      durationMs: 1,
      model: "m",
    });
    expect(getSessionInfo(CHAT).turnInProgress).toBe(false);
  });
});

describe("shared / accountFailedTurn", () => {
  it("records a failed turn and its burned tokens", () => {
    const state = makeState({ sdkInputTokens: 40, sdkOutputTokens: 2 });
    accountFailedTurn({
      backend: "opencode",
      chatId: CHAT,
      state,
      durationMs: 10,
      model: "m",
    });
    const session = getSession(CHAT);
    expect(session.metrics.lifetime.backend.opencode?.failedTurns).toBe(1);
    expect(session.usage.totalInputTokens).toBe(40);
  });

  it("uses the explicit usage override when the result never arrived", () => {
    const state = makeState();
    accountFailedTurn({
      backend: "claude",
      chatId: CHAT,
      state,
      durationMs: 10,
      model: "m",
      apiCalls: 3,
      usage: { inputTokens: 7, outputTokens: 1, cacheRead: 0, cacheWrite: 0 },
    });
    expect(getSession(CHAT).usage.totalInputTokens).toBe(7);
    expect(getSession(CHAT).usage.numApiCalls).toBe(3);
  });
});

describe("shared / nameSessionFromFirstMessage", () => {
  it("names the session from the first message only", () => {
    nameSessionFromFirstMessage({
      chatId: CHAT,
      text: "Plan my trip to Lisbon",
      previousTurns: 0,
    });
    const first = getSession(CHAT).sessionName;
    expect(first).toBeTruthy();
    nameSessionFromFirstMessage({
      chatId: CHAT,
      text: "Something else entirely",
      previousTurns: 1,
    });
    expect(getSession(CHAT).sessionName).toBe(first);
  });

  it("skips synthetic retry prompts", () => {
    nameSessionFromFirstMessage({
      chatId: CHAT,
      text: "[FLOW VIOLATION] retry now",
      previousTurns: 0,
      isRetry: true,
    });
    expect(getSession(CHAT).sessionName).toBeUndefined();
  });
});

describe("shared / enforceTrailingProse", () => {
  it("passes a terminated turn through untouched", () => {
    const result = enforceTrailingProse({
      chatId: CHAT,
      state: makeState({ lastTrailingText: "prose", turnTerminated: true }),
      flowRetries: 0,
    });
    expect(result.violated).toBe(false);
    expect(log).not.toHaveBeenCalled();
  });

  it("asks for a retry with the frontend reminder and counts it", () => {
    const result = enforceTrailingProse({
      chatId: CHAT,
      state: makeState({ lastTrailingText: "I forgot to call end_turn." }),
      flowRetries: 0,
      reminder: "[REMINDER] use send_message",
    });
    expect(result.violated).toBe(true);
    if (!result.violated) return;
    expect(result.shouldRetry).toBe(true);
    expect(result.reminder).toBe("[REMINDER] use send_message");
    expect(logLines()[0]).toBe(
      `[${CHAT}] flow violation: trailing prose (26 chars). Re-prompting with reminder.`,
    );
    const counters = getSession(CHAT).metrics.lifetime.counters;
    expect(counters.trailingTextDropped).toBe(1);
    expect(counters.flowViolationRetries).toBe(1);
    expect(counters.flowViolationCapExhausted).toBe(0);
  });

  it("accepts the drop once the retry cap is spent", () => {
    const result = enforceTrailingProse({
      chatId: CHAT,
      state: makeState({ toolCalls: 2 }),
      flowRetries: FLOW_VIOLATION_MAX_RETRIES,
    });
    expect(result.violated).toBe(true);
    if (!result.violated) return;
    expect(result.shouldRetry).toBe(false);
    expect(logLines()[0]).toBe(
      `[${CHAT}] flow violation: 2 tool calls with no terminator. ` +
        `Retry cap (${FLOW_VIOLATION_MAX_RETRIES}) exhausted — accepting silent drop.`,
    );
    const counters = getSession(CHAT).metrics.lifetime.counters;
    expect(counters.flowViolationRetries).toBe(0);
    expect(counters.flowViolationCapExhausted).toBe(1);
  });
});

describe("shared / finishCallbackTurn", () => {
  it("logs the delivery + summary lines, traces, and returns the result", () => {
    const state = makeState({
      sdkInputTokens: 80,
      sdkOutputTokens: 20,
      sdkCacheRead: 20,
      toolCalls: 2,
      turnTerminated: true,
      deliveredTextNorms: ["hello there"],
    });
    const result = finishCallbackTurn({
      chatId: CHAT,
      state,
      responseText: "scratch",
      durationMs: 500,
      setupMs: 40,
      turnMs: 460,
      delivery: { route: "tool", chars: 11 },
      detail: "events=delta×3",
    });
    expect(result).toEqual({
      text: "scratch",
      durationMs: 500,
      inputTokens: 80,
      outputTokens: 20,
      cacheRead: 20,
      cacheWrite: 0,
    });
    expect(logLines()).toEqual([
      `[${CHAT}] delivery: tool (11 chars)`,
      `[${CHAT}] -> (500ms in=80 out=20 cache=20% tools=2 terminator=yes ` +
        `delivered=1 respLen=7 setup=40ms turn=460ms events=delta×3)`,
    ]);
    expect(traceMessage).toHaveBeenCalledWith(CHAT, "out", "scratch", {
      durationMs: 500,
      toolCalls: 2,
    });
  });

  it("omits the detail suffix when none is given", () => {
    finishCallbackTurn({
      chatId: CHAT,
      state: makeState(),
      responseText: "",
      durationMs: 1,
      setupMs: 1,
      turnMs: 0,
      delivery: { route: "silent", chars: 0 },
    });
    expect(logLines()[1]).toMatch(/turn=0ms\)$/);
  });
});

describe("shared / buildResultEvents", () => {
  it("yields the usage event then the completed event sharing one usage", () => {
    const [usageEvent, completed] = buildResultEvents({
      text: "done",
      durationMs: 42,
      usage: { inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheWrite: 4 },
      modelId: "model-x",
    });
    expect(usageEvent).toEqual({
      type: "usage",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheRead: 3,
        cacheWrite: 4,
        modelId: "model-x",
      },
    });
    expect(completed.type).toBe("completed");
    if (completed.type !== "completed") return;
    expect(completed.result).toEqual({
      text: "done",
      durationMs: 42,
      usage: (usageEvent as { usage: unknown }).usage,
      modelId: "model-x",
    });
  });
});
