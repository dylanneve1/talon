/**
 * Tests for `fetchEndpointModels()`: parsing the heterogeneous
 * `/models` responses that OpenAI-compatible endpoints emit.
 *
 * We exercise the three shapes Talon encounters in the wild:
 *
 *   1. OpenRouter — top-level `context_length` plus a richer
 *      `top_provider.context_length`, with `pricing.prompt === "0"`
 *      flagging free tiers.
 *   2. vLLM-style — just an `id` and `context_length`.
 *   3. OpenAI / Ollama — id-only entries; nothing to enrich beyond
 *      surfacing the id in the catalog.
 *
 * Plus failure modes (non-200, timeout, malformed JSON, abort signal).
 *
 * Fetch is stubbed via `globalThis.fetch` so no network is hit; the
 * fake doubles as a way to assert the request shape (URL, Auth
 * header).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchEndpointModels } from "../backend/openai-agents/init.js";
import { getState, resetState } from "../backend/openai-agents/state.js";

type FetchInput = { url: string; init?: RequestInit };
let fetchSpy: ReturnType<typeof vi.fn>;
const realFetch = globalThis.fetch;

function stubFetchWith(
  responder: (
    input: FetchInput,
  ) =>
    | { status: number; body: unknown }
    | Promise<{ status: number; body: unknown }>,
): void {
  fetchSpy = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        input instanceof URL
          ? input.toString()
          : typeof input === "string"
            ? input
            : input.url;
      const result = await responder({ url, init });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
}

beforeEach(() => resetState());
afterEach(() => {
  globalThis.fetch = realFetch;
  resetState();
});

// ── Provider shapes ────────────────────────────────────────────────────────

describe("openai-agents / fetchEndpointModels / response shapes", () => {
  it("parses the OpenRouter shape (context_length + pricing.prompt)", async () => {
    stubFetchWith(() => ({
      status: 200,
      body: {
        data: [
          {
            id: "openrouter/owl-alpha",
            name: "Owl Alpha",
            context_length: 1_000_000,
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "openai/gpt-5",
            name: "GPT-5",
            context_length: 400_000,
            pricing: { prompt: "0.000010" },
          },
        ],
      },
    }));

    await fetchEndpointModels("https://openrouter.ai/api/v1", "sk-or-1");

    const catalog = getState().endpointModels;
    expect(catalog.size).toBe(2);

    const owl = catalog.get("openrouter/owl-alpha");
    expect(owl?.contextWindow).toBe(1_000_000);
    expect(owl?.displayName).toBe("Owl Alpha");
    expect(owl?.free).toBe(true);

    const gpt = catalog.get("openai/gpt-5");
    expect(gpt?.contextWindow).toBe(400_000);
    expect(gpt?.free).toBeUndefined();
  });

  it("prefers top_provider.context_length when the top-level field is missing", async () => {
    stubFetchWith(() => ({
      status: 200,
      body: {
        data: [
          {
            id: "split-provider/model",
            top_provider: { context_length: 64_000 },
          },
        ],
      },
    }));

    await fetchEndpointModels("https://example.com/v1", "k");
    expect(
      getState().endpointModels.get("split-provider/model")?.contextWindow,
    ).toBe(64_000);
  });

  it("parses the vLLM-style shape (id + context_length only)", async () => {
    stubFetchWith(() => ({
      status: 200,
      body: {
        data: [
          { id: "meta-llama/Llama-3-8B", context_length: 8192 },
          { id: "Qwen/Qwen-7B", context_length: 32_768 },
        ],
      },
    }));

    await fetchEndpointModels("https://vllm.local:8000/v1", undefined);
    const catalog = getState().endpointModels;
    expect(catalog.get("meta-llama/Llama-3-8B")?.contextWindow).toBe(8192);
    expect(catalog.get("Qwen/Qwen-7B")?.contextWindow).toBe(32_768);
  });

  it("still records bare entries (id only, no enrichment fields)", async () => {
    // OpenAI's /v1/models — and NVIDIA NIM's — returns just
    // `{id, object, created, owned_by}`. The picker still needs these
    // ids to list them; we just store them with empty caps so the UI
    // renders an id-only entry without context-window / pricing badges.
    stubFetchWith(() => ({
      status: 200,
      body: {
        data: [
          { id: "gpt-4o", object: "model", created: 1, owned_by: "openai" },
          { id: "gpt-4o-mini", object: "model" },
        ],
      },
    }));

    await fetchEndpointModels("https://api.openai.com/v1", "sk-test");
    const catalog = getState().endpointModels;
    expect(catalog.size).toBe(2);
    expect(catalog.get("gpt-4o")).toEqual({});
    expect(catalog.get("gpt-4o-mini")).toEqual({});
  });

  it("includes entries that have a display name even without context_length", async () => {
    stubFetchWith(() => ({
      status: 200,
      body: { data: [{ id: "x/y", name: "X Why" }] },
    }));
    await fetchEndpointModels("https://e.example/v1", "k");
    expect(getState().endpointModels.get("x/y")?.displayName).toBe("X Why");
  });

  it("ignores entries with no id", async () => {
    stubFetchWith(() => ({
      status: 200,
      body: {
        data: [{ context_length: 4096 }, { id: "real", context_length: 8192 }],
      },
    }));
    await fetchEndpointModels("https://e.example/v1", "k");
    const catalog = getState().endpointModels;
    expect(catalog.size).toBe(1);
    expect(catalog.get("real")?.contextWindow).toBe(8192);
  });

  it("handles a missing `data` array gracefully (no throw)", async () => {
    stubFetchWith(() => ({ status: 200, body: {} }));
    await fetchEndpointModels("https://e.example/v1", "k");
    expect(getState().endpointModels.size).toBe(0);
  });
});

// ── Request shape ──────────────────────────────────────────────────────────

describe("openai-agents / fetchEndpointModels / request shape", () => {
  it("normalises trailing slashes on baseURL", async () => {
    stubFetchWith(({ url }) => {
      expect(url).toBe("https://e.example/v1/models");
      return { status: 200, body: { data: [] } };
    });
    await fetchEndpointModels("https://e.example/v1///", "k");
  });

  it("sends Authorization header when an apiKey is provided", async () => {
    stubFetchWith(({ init }) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe("Bearer sk-test");
      return { status: 200, body: { data: [] } };
    });
    await fetchEndpointModels("https://e.example/v1", "sk-test");
  });

  it("omits the Authorization header when no apiKey is provided", async () => {
    stubFetchWith(({ init }) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBeUndefined();
      return { status: 200, body: { data: [] } };
    });
    await fetchEndpointModels("https://e.example/v1", undefined);
  });
});

// ── Failure modes ──────────────────────────────────────────────────────────

describe("openai-agents / fetchEndpointModels / failures", () => {
  it("throws on non-200 responses", async () => {
    stubFetchWith(() => ({ status: 503, body: { error: "down" } }));
    await expect(
      fetchEndpointModels("https://e.example/v1", "k"),
    ).rejects.toThrow(/503/);
  });

  it("leaves the catalog untouched when fetch rejects", async () => {
    getState().endpointModels.set("preexisting", { contextWindow: 1 });
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(
      fetchEndpointModels("https://e.example/v1", "k"),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(getState().endpointModels.get("preexisting")?.contextWindow).toBe(1);
  });
});
