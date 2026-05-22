/**
 * Tests for the discovery module:
 *
 *   - `startDiscovery` — kicks off a `/models` fetch and stashes the
 *     promise on state so the picker can `await awaitDiscovery()`.
 *   - `awaitDiscovery` — soft-timeout wait used by the picker on
 *     first render so an in-flight catalog fetch isn't raced.
 *   - `refreshDiscovery` — forces a fresh `/models` round-trip
 *     bypassing the dedup cache.
 *   - `extractCapabilities` — pure-ish helper exposing the
 *     provider-shape decisions for direct unit-testing.
 *   - Free-pricing detection — string "0" / "0.0" / numeric 0 / etc.
 *
 * Fetch is stubbed via `globalThis.fetch` so no network is hit and
 * we can assert request shape / control timing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startDiscovery,
  awaitDiscovery,
  refreshDiscovery,
  extractCapabilities,
  hasDiscoveredCatalog,
} from "../backend/openai-agents/discovery.js";
import { getState, resetState } from "../backend/openai-agents/state.js";

const realFetch = globalThis.fetch;

interface StubOptions {
  body?: unknown;
  status?: number;
  delayMs?: number;
}

function stubFetchOnce(opts: StubOptions = {}): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    if (opts.delayMs && opts.delayMs > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs));
    }
    return new Response(JSON.stringify(opts.body ?? { data: [] }), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

beforeEach(() => resetState());
afterEach(() => {
  globalThis.fetch = realFetch;
  resetState();
});

// ── startDiscovery / awaitDiscovery ────────────────────────────────────────

describe("openai-agents / discovery", () => {
  it("startDiscovery stashes an in-flight promise on state", async () => {
    stubFetchOnce({
      body: { data: [{ id: "m1", context_length: 128_000 }] },
      delayMs: 25,
    });
    const before = getState().discoveryPromise;
    expect(before).toBeNull();

    const p = startDiscovery("https://e.example/v1", "k");
    expect(getState().discoveryPromise).not.toBeNull();

    await p;
    // Promise reference cleared after settle.
    expect(getState().discoveryPromise).toBeNull();
    expect(getState().endpointModels.get("m1")?.contextWindow).toBe(128_000);
  });

  it("startDiscovery is idempotent while one is in flight", async () => {
    const fetchFn = stubFetchOnce({
      body: { data: [{ id: "m1", context_length: 1 }] },
      delayMs: 30,
    });
    const p1 = startDiscovery("https://e.example/v1", "k");
    const p2 = startDiscovery("https://e.example/v1", "k");
    expect(p1).toBe(p2);
    await p1;
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("awaitDiscovery resolves immediately when nothing is in flight", async () => {
    const start = Date.now();
    await awaitDiscovery(5_000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("awaitDiscovery resolves when the in-flight promise settles", async () => {
    stubFetchOnce({
      body: { data: [{ id: "m1", context_length: 4096 }] },
      delayMs: 20,
    });
    void startDiscovery("https://e.example/v1", "k");
    await awaitDiscovery(2_000);
    expect(getState().endpointModels.get("m1")?.contextWindow).toBe(4096);
  });

  it("awaitDiscovery respects its soft timeout when the fetch is slow", async () => {
    stubFetchOnce({
      body: { data: [{ id: "m1" }] },
      delayMs: 200,
    });
    void startDiscovery("https://e.example/v1", "k");
    const start = Date.now();
    await awaitDiscovery(40);
    // ±20ms slop for timer scheduling — definitely well under the
    // 200ms fetch delay.
    expect(Date.now() - start).toBeLessThan(180);
  });

  it("survives a failing fetch without throwing — promise is cleared", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await startDiscovery("https://e.example/v1", "k");
    expect(getState().discoveryPromise).toBeNull();
    expect(getState().endpointModels.size).toBe(0);
  });

  it("refreshDiscovery forces a fresh fetch even when one already settled", async () => {
    const fetchFn = stubFetchOnce({
      body: { data: [{ id: "m1", context_length: 1 }] },
    });
    await startDiscovery("https://e.example/v1", "k");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await refreshDiscovery("https://e.example/v1", "k");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("hasDiscoveredCatalog reflects state.endpointModels", async () => {
    expect(hasDiscoveredCatalog()).toBe(false);
    stubFetchOnce({
      body: { data: [{ id: "m1", context_length: 1 }] },
    });
    await startDiscovery("https://e.example/v1", "k");
    expect(hasDiscoveredCatalog()).toBe(true);
  });
});

// ── extractCapabilities ────────────────────────────────────────────────────

describe("openai-agents / extractCapabilities", () => {
  it("pulls context_length when present", () => {
    expect(extractCapabilities({ id: "m", context_length: 8192 })).toEqual({
      contextWindow: 8192,
    });
  });

  it("falls back to top_provider.context_length", () => {
    expect(
      extractCapabilities({
        id: "m",
        top_provider: { context_length: 64_000 },
      }),
    ).toEqual({ contextWindow: 64_000 });
  });

  it("ignores zero / negative context", () => {
    expect(extractCapabilities({ id: "m", context_length: 0 })).toEqual({});
    expect(extractCapabilities({ id: "m", context_length: -1 })).toEqual({});
  });

  it("captures display name when present", () => {
    expect(extractCapabilities({ id: "m", name: "X" })).toEqual({
      displayName: "X",
    });
  });

  it("flags free when pricing.prompt is string '0'", () => {
    expect(extractCapabilities({ id: "m", pricing: { prompt: "0" } })).toEqual({
      free: true,
    });
  });

  it("flags free for numeric 0 (vLLM doesn't quote the price)", () => {
    expect(extractCapabilities({ id: "m", pricing: { prompt: 0 } })).toEqual({
      free: true,
    });
  });

  it("flags free for '0.0' / '0e0' / whitespace-padded zero", () => {
    expect(
      extractCapabilities({ id: "m", pricing: { prompt: "0.0" } }),
    ).toEqual({ free: true });
    expect(
      extractCapabilities({ id: "m", pricing: { prompt: "0e0" } }),
    ).toEqual({ free: true });
    expect(
      extractCapabilities({ id: "m", pricing: { prompt: "  0  " } }),
    ).toEqual({ free: true });
  });

  it("does NOT flag free for paid models (even very cheap)", () => {
    expect(
      extractCapabilities({ id: "m", pricing: { prompt: "0.0000001" } }),
    ).toEqual({});
    expect(extractCapabilities({ id: "m", pricing: { prompt: "1" } })).toEqual(
      {},
    );
  });

  it("does NOT flag free for malformed prompt prices", () => {
    expect(extractCapabilities({ id: "m", pricing: { prompt: "" } })).toEqual(
      {},
    );
    expect(
      extractCapabilities({ id: "m", pricing: { prompt: "free" } }),
    ).toEqual({});
  });

  it("combines fields into one caps object when all three apply", () => {
    expect(
      extractCapabilities({
        id: "m",
        name: "X",
        context_length: 4096,
        pricing: { prompt: "0" },
      }),
    ).toEqual({
      contextWindow: 4096,
      displayName: "X",
      free: true,
    });
  });

  it("captures endpoint-advertised reasoning levels", () => {
    expect(
      extractCapabilities({
        id: "m",
        supported_reasoning_levels: [
          { effort: "low" },
          { effort: "high" },
          { effort: "bogus" },
        ],
        default_reasoning_level: "low",
      }),
    ).toEqual({
      supportedReasoningLevels: ["low", "high"],
      defaultReasoningLevel: "low",
    });
  });

  it("captures Anthropic-style effort capability objects when an endpoint provides them", () => {
    expect(
      extractCapabilities({
        id: "m",
        capabilities: {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: false },
            high: { supported: true },
            max: { supported: true },
            xhigh: null,
          },
        },
      }),
    ).toEqual({
      supportedReasoningLevels: ["low", "high", "max"],
    });
  });
});
