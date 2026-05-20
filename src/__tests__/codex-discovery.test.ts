/**
 * Codex `/v1/models` discovery tests.
 *
 * Covers the fire-and-forget background fetch, the soft-wait
 * `awaitDiscovery` semantics, the no-api-key short-circuit, and the
 * id filter that drops embeddings/audio/image/legacy completions.
 *
 * `global.fetch` is stubbed in each test that exercises the HTTP
 * path so we don't hit OpenAI for real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  startDiscovery,
  awaitDiscovery,
  refreshDiscovery,
  fetchOpenAiModels,
  isCodexCompatibleModel,
  hasDiscoveredCatalog,
  hasAttemptedDiscovery,
} from "../backend/codex/discovery.js";
import { getState, resetState } from "../backend/codex/state.js";

beforeEach(() => {
  resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── isCodexCompatibleModel — id-filter unit tests ─────────────────────

describe("codex / isCodexCompatibleModel", () => {
  it("keeps gpt-5 family", () => {
    expect(isCodexCompatibleModel("gpt-5")).toBe(true);
    expect(isCodexCompatibleModel("gpt-5-mini")).toBe(true);
    expect(isCodexCompatibleModel("gpt-5.5")).toBe(true);
    expect(isCodexCompatibleModel("gpt-5-codex")).toBe(true);
  });

  it("keeps gpt-4 family", () => {
    expect(isCodexCompatibleModel("gpt-4o")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4.1")).toBe(true);
    expect(isCodexCompatibleModel("gpt-4o-mini")).toBe(true);
  });

  it("keeps o3 and o4 reasoning families", () => {
    expect(isCodexCompatibleModel("o3")).toBe(true);
    expect(isCodexCompatibleModel("o3-pro")).toBe(true);
    expect(isCodexCompatibleModel("o4-mini")).toBe(true);
  });

  it("keeps chatgpt-* aliases", () => {
    expect(isCodexCompatibleModel("chatgpt-4o-latest")).toBe(true);
  });

  it("drops embeddings", () => {
    expect(isCodexCompatibleModel("text-embedding-3-small")).toBe(false);
    expect(isCodexCompatibleModel("text-embedding-ada-002")).toBe(false);
  });

  it("drops image-gen", () => {
    expect(isCodexCompatibleModel("dall-e-3")).toBe(false);
    expect(isCodexCompatibleModel("dall-e-2")).toBe(false);
  });

  it("drops audio / tts / whisper", () => {
    expect(isCodexCompatibleModel("whisper-1")).toBe(false);
    expect(isCodexCompatibleModel("tts-1")).toBe(false);
    expect(isCodexCompatibleModel("tts-1-hd")).toBe(false);
    expect(isCodexCompatibleModel("gpt-4o-audio-preview")).toBe(false);
  });

  it("drops moderation + legacy completions", () => {
    expect(isCodexCompatibleModel("text-moderation-latest")).toBe(false);
    expect(isCodexCompatibleModel("babbage-002")).toBe(false);
    expect(isCodexCompatibleModel("davinci-002")).toBe(false);
  });

  it("drops empty / non-string ids", () => {
    expect(isCodexCompatibleModel("")).toBe(false);
    expect(isCodexCompatibleModel(undefined as unknown as string)).toBe(false);
  });

  it("drops realtime + search variants (not chat-completion compatible)", () => {
    expect(isCodexCompatibleModel("gpt-4o-realtime-preview")).toBe(false);
    expect(isCodexCompatibleModel("gpt-4o-search-preview")).toBe(false);
  });
});

// ── startDiscovery / awaitDiscovery — lifecycle ───────────────────────

describe("codex / startDiscovery without api key", () => {
  it("resolves immediately and marks discovery attempted", async () => {
    const promise = startDiscovery(undefined);
    await promise;
    expect(getState().discoveryAt).not.toBeNull();
    expect(getState().discoveryPromise).toBeNull();
    expect(hasAttemptedDiscovery()).toBe(true);
    expect(hasDiscoveredCatalog()).toBe(false);
  });

  it("does not call fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    await startDiscovery(undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("codex / startDiscovery with api key — happy path", () => {
  it("populates discoveredModels from a /v1/models response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-5.5", object: "model" },
            { id: "gpt-5", object: "model" },
            { id: "gpt-5-codex", object: "model" },
            { id: "text-embedding-3-small", object: "model" }, // dropped
            { id: "whisper-1", object: "model" }, // dropped
            { id: "o4-mini", object: "model" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await startDiscovery("sk-test-key");

    const ids = Array.from(getState().discoveredModels).sort();
    expect(ids).toEqual(["gpt-5", "gpt-5-codex", "gpt-5.5", "o4-mini"]);
    expect(hasDiscoveredCatalog()).toBe(true);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("sends the api key as a bearer token", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    await startDiscovery("sk-bearer-test");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-bearer-test");
  });

  it("respects a custom baseUrl override", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    await startDiscovery("sk-key", "https://my-proxy.example/v1");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://my-proxy.example/v1/models");
  });

  it("strips trailing slashes from baseUrl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );
    await startDiscovery("sk-key", "https://api.openai.com/v1///");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/models");
  });
});

describe("codex / startDiscovery with api key — failure paths", () => {
  it("swallows 401 / 403 silently, leaves catalog empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );
    await startDiscovery("sk-bad");
    expect(getState().discoveredModels.size).toBe(0);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("swallows network errors silently", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:443"),
    );
    await startDiscovery("sk-key");
    expect(getState().discoveredModels.size).toBe(0);
    expect(hasAttemptedDiscovery()).toBe(true);
  });

  it("clears the in-flight promise even on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await startDiscovery("sk-key");
    expect(getState().discoveryPromise).toBeNull();
  });
});

describe("codex / startDiscovery idempotency", () => {
  it("returns the same promise when called twice in flight", async () => {
    let resolveOuter!: (v: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolveOuter = r;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending);

    const p1 = startDiscovery("sk-key");
    const p2 = startDiscovery("sk-key");
    expect(p1).toBe(p2);

    resolveOuter(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await p1;
  });
});

describe("codex / awaitDiscovery", () => {
  it("returns immediately when no discovery is pending", async () => {
    const start = Date.now();
    await awaitDiscovery(5_000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("waits for an in-flight discovery to settle", async () => {
    let resolveOuter!: (v: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolveOuter = r;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(pending);

    const discovery = startDiscovery("sk-key");
    const awaiter = awaitDiscovery(5_000);

    // Give the awaiter a tick to attach
    await new Promise((r) => setImmediate(r));

    resolveOuter(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }] }),
        { status: 200 },
      ),
    );
    await discovery;
    await awaiter;
    expect(getState().discoveredModels.has("gpt-5.5")).toBe(true);
  });

  it("times out after the soft window without blocking forever", async () => {
    // Never-resolving fetch
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise(() => {}));
    void startDiscovery("sk-key");

    const start = Date.now();
    await awaitDiscovery(20);
    const elapsed = Date.now() - start;
    // Setting a 20ms timer can resolve a millisecond early on busy
    // systems (Node's timer wheel drift) — allow 18ms as the floor.
    expect(elapsed).toBeGreaterThanOrEqual(18);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("codex / refreshDiscovery", () => {
  it("clears the previous result and re-fetches", async () => {
    // First fetch: returns gpt-5.5
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-5.5", object: "model" }] }),
        { status: 200 },
      ),
    );
    await startDiscovery("sk-key");
    expect(Array.from(getState().discoveredModels)).toEqual(["gpt-5.5"]);

    // Second fetch (after refresh): gpt-5 only — old gpt-5.5 must be cleared
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [{ id: "gpt-5", object: "model" }] }),
        { status: 200 },
      ),
    );
    await refreshDiscovery("sk-key");
    expect(Array.from(getState().discoveredModels)).toEqual(["gpt-5"]);
  });
});

describe("codex / fetchOpenAiModels malformed responses", () => {
  it("tolerates non-array `data`", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: "not an array" }), { status: 200 }),
    );
    await fetchOpenAiModels("sk-key");
    expect(getState().discoveredModels.size).toBe(0);
  });

  it("tolerates entries missing `id`", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { object: "model" }, // no id
            { id: 42 }, // non-string id
            { id: "gpt-5.5", object: "model" },
          ],
        }),
        { status: 200 },
      ),
    );
    await fetchOpenAiModels("sk-key");
    expect(Array.from(getState().discoveredModels)).toEqual(["gpt-5.5"]);
  });

  it("throws on non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500 }),
    );
    await expect(fetchOpenAiModels("sk-key")).rejects.toThrow(/500/);
  });
});
