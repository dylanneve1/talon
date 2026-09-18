/**
 * Per-turn phase timing: the Weaver measures where a turn's wall-clock
 * went (queue wait, warp resolve, first token, stream, delivery), folds
 * it into the chat's session metrics, and the snapshot surfaces each
 * phase as a `turn.*_ms` histogram next to `response_latency_ms`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Weaver } from "../core/weaver/index.js";
import { carryTurnEvents, startShuttleTiming } from "../core/weaver/shuttle.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";
import { getMetrics, resetMetrics } from "../storage/metrics.js";
import { getSession, recordSessionTurnPhases } from "../storage/sessions.js";
import { normaliseMetrics } from "../storage/session-record.js";
import {
  bootPhase,
  bootReport,
  resetBootPhases,
} from "../core/daemon/boot-timer.js";
import type { ExecuteParams } from "../core/types.js";
import { stubBackend, stubResolveActiveModel } from "./helpers/stub-backend.js";

beforeEach(() => resetMetrics());
afterEach(() => resetMetrics());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function* stream(...events: AgentEvent[]): AsyncGenerator<AgentEvent> {
  for (const event of events) yield event;
}

describe("session turn phases", () => {
  it("folds phase timings into lifetime + today and surfaces turn.*_ms histograms", () => {
    recordSessionTurnPhases("phases-chat", {
      queueWait: 10,
      warpResolve: 2,
      firstToken: 800,
      stream: 3000,
      delivery: 120,
    });
    recordSessionTurnPhases("phases-chat", { firstToken: 400, stream: 1000 });

    const { histograms } = getMetrics();
    expect(histograms["turn.first_token_ms"]).toEqual({
      count: 2,
      avg: 600,
      min: 400,
      max: 800,
    });
    expect(histograms["turn.stream_ms"].count).toBe(2);
    expect(histograms["turn.queue_wait_ms"].count).toBe(1);
    expect(histograms["turn.delivery_ms"]).toEqual({
      count: 1,
      avg: 120,
      min: 120,
      max: 120,
    });

    const { metrics } = getSession("phases-chat");
    expect(metrics.lifetime.phases.firstToken.count).toBe(2);
    expect(Object.values(metrics.buckets)[0]?.phases.firstToken.count).toBe(2);
  });

  it("normalises records persisted before phases existed", () => {
    const legacy = normaliseMetrics({
      lifetime: { counters: { queries: 3 }, latency: { count: 3, sumMs: 30 } },
      buckets: {},
    });
    expect(legacy.lifetime.counters.queries).toBe(3);
    expect(legacy.lifetime.phases.firstToken).toEqual({
      count: 0,
      sumMs: 0,
      minMs: Infinity,
      maxMs: 0,
    });
  });
});

describe("shuttle timing", () => {
  it("stamps the first event and sums time spent in the sink", async () => {
    const timing = startShuttleTiming();
    const before = Date.now();
    await carryTurnEvents(
      stream(
        { type: "text_delta", text: "a" },
        { type: "text_delta", text: "b" },
      ),
      async () => {
        await sleep(15);
      },
      timing,
    );
    expect(timing.firstEventAt).toBeGreaterThanOrEqual(before);
    expect(timing.deliveryMs).toBeGreaterThanOrEqual(20);
  });

  it("leaves firstEventAt unset for an empty stream and counts nothing without a sink", async () => {
    const timing = startShuttleTiming();
    await carryTurnEvents(stream(), undefined, timing);
    expect(timing.firstEventAt).toBeUndefined();
    expect(timing.deliveryMs).toBe(0);
  });
});

describe("weaver phase recording", () => {
  function params(input: Partial<ExecuteParams> = {}): ExecuteParams {
    return {
      chatId: input.chatId ?? "weaver-phases",
      numericChatId: 1,
      prompt: "hello",
      senderName: "User",
      isGroup: false,
      source: "message",
      onEvent: input.onEvent,
    };
  }

  it("records every phase for a completed turn", async () => {
    const backend = stubBackend({
      query: vi.fn(async () => {
        await sleep(5);
        return {
          text: "done",
          durationMs: 5,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }),
    });
    const weaver = new Weaver({
      getBackend: () => backend,
      resolveActiveModel: stubResolveActiveModel(),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });
    await weaver.runTurn(params({ onEvent: async () => {} }));

    const { phases } = getSession("weaver-phases").metrics.lifetime;
    expect(phases.queueWait.count).toBe(1);
    expect(phases.warpResolve.count).toBe(1);
    expect(phases.firstToken.count).toBe(1);
    expect(phases.stream.count).toBe(1);
    expect(phases.delivery.count).toBe(1);
    expect(phases.stream.maxMs).toBeGreaterThanOrEqual(phases.firstToken.maxMs);
  });

  it("records nothing for a no-model refusal", async () => {
    const weaver = new Weaver({
      getBackend: () => stubBackend(),
      resolveActiveModel: async () => ({
        model: null,
        ref: null,
        backendId: "stub",
      }),
      context: { acquire: vi.fn(), release: vi.fn(), getMessageCount: () => 0 },
      sendTyping: vi.fn(async () => {}),
    });
    await weaver.runTurn(params({ chatId: "weaver-refusal" }));
    expect(
      getSession("weaver-refusal").metrics.lifetime.phases.stream.count,
    ).toBe(0);
  });
});

describe("boot timer", () => {
  beforeEach(() => resetBootPhases());

  it("times each phase and reports them with the process total", async () => {
    const value = await bootPhase("stores", () => 42);
    await bootPhase("frontends", async () => {
      await sleep(5);
    });
    expect(value).toBe(42);
    expect(bootReport(1234)).toMatch(
      /^1234ms \(stores \d+ms, frontends \d+ms\)$/,
    );
  });

  it("still records a phase that throws", async () => {
    await expect(
      bootPhase("boom", () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    expect(bootReport(1)).toContain("boom");
  });
});
