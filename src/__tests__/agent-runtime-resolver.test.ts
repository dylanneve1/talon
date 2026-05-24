/**
 * Phase 2 tests — `resolveActiveModelRefForChat`.
 *
 * The new resolver wraps the existing string-side chain in
 * `core/active-model.ts` and enriches the returned id into a
 * `ModelRef`. The tests below pin:
 *
 *   - Source mapping (every `ActiveModelSource` → `ModelSource`)
 *   - Enrichment via `getModelInfo` (preferred path)
 *   - Enrichment via `resolveModel` (fallback path)
 *   - Bare ref fallback when neither catalog method is available
 *   - `cacheSupport` propagation from the backend's `cacheMetrics`
 *   - `BackendId` validation — unknown ids produce `ref: null`
 *   - `getModelInfo` and `resolveModel` thrown errors swallowed,
 *     falling through to the next strategy
 *   - `source === "none"` → `ref: null`
 *   - `getActiveModelRefForChat` convenience wrapper
 *   - The existing string-side resolver is not regressed (smoke).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  QueryBackend,
  UnifiedModelInfo,
  UnifiedModelResolution,
} from "../core/types.js";
import type { TalonConfig } from "../util/config.js";

vi.mock("../util/log.js", () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => "{}"),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("write-file-atomic", () => ({
  default: { sync: vi.fn() },
}));

const { resolveActiveModelRefForChat, getActiveModelRefForChat } =
  await import("../core/agent-runtime/resolver.js");
const { setChatModelForBackend } = await import("../storage/chat-settings.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

function fakeConfig(opts: Partial<TalonConfig> = {}): TalonConfig {
  return {
    model: "claude-opus-4-7",
    backend: "claude",
    ...opts,
  } as unknown as TalonConfig;
}

function fullInfo(overrides: Partial<UnifiedModelInfo> = {}): UnifiedModelInfo {
  return {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    free: false,
    contextWindow: 272_000,
    reasoning: true,
    supportedReasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
    ...overrides,
  };
}

function exact(id: string, selectable = true): UnifiedModelResolution {
  return {
    kind: "exact",
    model: fullInfo({ id, displayName: id, selectable }),
    storedValue: id,
  };
}

function missing(): UnifiedModelResolution {
  return { kind: "missing" };
}

function fakeBackend(
  opts: {
    resolveModel?: (q: string) => Promise<UnifiedModelResolution>;
    getDefaultModel?: () => Promise<string | null> | string | null;
    getModelInfo?: (id: string) => Promise<UnifiedModelInfo | undefined>;
    cacheMetrics?: QueryBackend["cacheMetrics"];
  } = {},
): QueryBackend {
  const be: Partial<QueryBackend> = {
    query: vi.fn().mockResolvedValue({
      text: "",
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  };
  if (opts.resolveModel) be.resolveModel = opts.resolveModel;
  if (opts.getDefaultModel) be.getDefaultModel = opts.getDefaultModel;
  if (opts.getModelInfo) be.getModelInfo = opts.getModelInfo;
  if (opts.cacheMetrics !== undefined) be.cacheMetrics = opts.cacheMetrics;
  return be as QueryBackend;
}

let chatCounter = 0;
const nextChatId = () => `agent-runtime-resolver-${++chatCounter}`;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Enrichment strategies ───────────────────────────────────────────────────

describe("resolveActiveModelRefForChat / enrichment", () => {
  it("uses getModelInfo when available and returns a full ModelRef", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    const be = fakeBackend({
      resolveModel: vi.fn(async () => exact("gpt-5.5")),
      getModelInfo: vi.fn(async (id) =>
        id === "gpt-5.5"
          ? fullInfo({ id, displayName: "GPT-5.5", contextWindow: 272_000 })
          : undefined,
      ),
      cacheMetrics: "read",
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(source).toBe("override-valid");
    expect(ref).toMatchObject({
      backend: "codex",
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      provider: "openai",
      contextWindow: 272_000,
      cacheSupport: "read",
      selectable: true,
      source: "chat",
      effortLevels: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
    expect(be.getModelInfo).toHaveBeenCalledWith("gpt-5.5");
  });

  it("falls back to resolveModel when getModelInfo is absent", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5-codex");
    const be = fakeBackend({
      resolveModel: vi.fn(async () =>
        exact("gpt-5-codex"),
      ) as unknown as QueryBackend["resolveModel"],
      cacheMetrics: "readwrite",
    });
    const { ref } = await resolveActiveModelRefForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(ref).toMatchObject({
      backend: "codex",
      id: "gpt-5-codex",
      displayName: "gpt-5-codex",
      cacheSupport: "readwrite",
      source: "chat",
    });
  });

  it("falls back to a bare ref when neither catalog method matches", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "kilo", "mystery-model");
    const be = fakeBackend({
      resolveModel: vi.fn(async () => exact("mystery-model")),
      getModelInfo: vi.fn(async () => undefined),
      cacheMetrics: "none",
    });
    const { ref } = await resolveActiveModelRefForChat(
      cid,
      be,
      "kilo",
      fakeConfig(),
    );
    // getModelInfo returned undefined; resolveModel happens to know the id
    expect(ref?.backend).toBe("kilo");
    expect(ref?.id).toBe("mystery-model");
    expect(ref?.cacheSupport).toBe("none");
  });

  it("propagates cacheMetrics: undefined → 'none'", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "claude", "claude-opus-4-7");
    const be = fakeBackend({
      resolveModel: vi.fn(async () => exact("claude-opus-4-7")),
    });
    const { ref } = await resolveActiveModelRefForChat(
      cid,
      be,
      "claude",
      fakeConfig(),
    );
    expect(ref?.cacheSupport).toBe("none");
  });

  it("returns a bare ref when no catalog method exists at all", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "claude", "claude-opus-4-7");
    // backend with no resolveModel and no getModelInfo — the
    // string-side chain falls through to step 2 (no canonical) and
    // returns model: null. Mirror that branch.
    const be = fakeBackend({ cacheMetrics: "readwrite" });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "claude",
      fakeConfig(),
    );
    // step 1 trusts the stored override when there's no resolveModel
    expect(ref?.backend).toBe("claude");
    expect(ref?.id).toBe("claude-opus-4-7");
    expect(ref?.cacheSupport).toBe("readwrite");
    expect(ref?.displayName).toBe("claude-opus-4-7");
    expect(ref?.source).toBe("chat");
    expect(source).toBe("override-valid");
  });
});

// ── Source mapping ──────────────────────────────────────────────────────────

describe("resolveActiveModelRefForChat / source mapping", () => {
  it("override-valid → ModelRef.source = 'chat'", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    const be = fakeBackend({
      resolveModel: vi.fn(async () => exact("gpt-5.5")),
      getModelInfo: vi.fn(async () => fullInfo()),
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(source).toBe("override-valid");
    expect(ref?.source).toBe("chat");
  });

  it("backend-canonical → ModelRef.source = 'backend-default'", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: vi.fn(async () => missing()),
      getDefaultModel: () => "claude-opus-4-7",
      getModelInfo: vi.fn(async (id) => fullInfo({ id })),
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "claude",
      fakeConfig({ backend: "claude" }),
    );
    expect(source).toBe("backend-canonical");
    expect(ref?.source).toBe("backend-default");
  });

  it("config-backend-defaults → ModelRef.source = 'config'", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: vi.fn(async () => missing()),
      // no canonical default
      getModelInfo: vi.fn(async (id) => fullInfo({ id })),
    });
    const cfg = fakeConfig({
      backend: "openai-agents",
      backendDefaults: { "openai-agents": "owl-alpha" },
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "openai-agents",
      cfg,
    );
    expect(source).toBe("config-backend-defaults");
    expect(ref?.source).toBe("config");
    expect(ref?.id).toBe("owl-alpha");
  });

  it("config-legacy-global → ModelRef.source = 'config'", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: vi.fn(async () => missing()),
      getModelInfo: vi.fn(async (id) => fullInfo({ id })),
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "claude",
      fakeConfig({ backend: "claude", model: "claude-opus-4-7" }),
    );
    expect(source).toBe("config-legacy-global");
    expect(ref?.source).toBe("config");
    expect(ref?.id).toBe("claude-opus-4-7");
  });

  it("override-invalid-fallback → ModelRef.source = 'fallback'", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "not-a-real-model");
    const be = fakeBackend({
      resolveModel: vi.fn(async (q) =>
        q === "not-a-real-model" ? missing() : exact("gpt-5.5"),
      ),
      getDefaultModel: () => "gpt-5.5",
      getModelInfo: vi.fn(async (id) => fullInfo({ id })),
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(source).toBe("override-invalid-fallback");
    expect(ref?.source).toBe("fallback");
    expect(ref?.id).toBe("gpt-5.5");
  });
});

// ── Null / edge cases ───────────────────────────────────────────────────────

describe("resolveActiveModelRefForChat / null + edge cases", () => {
  it("returns ref: null + source 'none' when the chain exhausts", async () => {
    const cid = nextChatId();
    // catalog-driven backend without canonical, no operator default,
    // not the global backend, no per-chat override
    const be = fakeBackend({
      resolveModel: vi.fn(async () => missing()),
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "kilo",
      fakeConfig({ backend: "claude" /* not kilo */ }),
    );
    expect(ref).toBeNull();
    expect(source).toBe("none");
  });

  it("returns ref: null when backendId is not a known BackendId", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: vi.fn(async () => exact("anything")),
      getDefaultModel: () => "anything",
    });
    const { ref } = await resolveActiveModelRefForChat(
      cid,
      be,
      "totally-not-a-backend",
      fakeConfig(),
    );
    // chain returned a model string, but we can't form a ModelRef
    // without a typed BackendId — caller must use the string API.
    expect(ref).toBeNull();
  });

  it("returns ref: null when backendId is null even if config.model is set", async () => {
    const cid = nextChatId();
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      null,
      null,
      fakeConfig({ backend: "claude", model: "claude-opus-4-7" }),
    );
    // string-side returns config-legacy-global but we can't type it
    expect(ref).toBeNull();
    expect(source).toBe("config-legacy-global");
  });

  it("survives getModelInfo throwing and falls through to resolveModel", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    const be = fakeBackend({
      resolveModel: vi.fn(async () => exact("gpt-5.5")),
      getModelInfo: vi.fn(async () => {
        throw new Error("catalog cache miss");
      }),
      cacheMetrics: "read",
    });
    const { ref } = await resolveActiveModelRefForChat(
      cid,
      be,
      "codex",
      fakeConfig(),
    );
    expect(ref?.id).toBe("gpt-5.5");
    expect(ref?.cacheSupport).toBe("read");
  });

  it("survives resolveModel throwing and returns a bare ref", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    // To exercise the resolveModel-throws-in-enrichment branch, we
    // need the chain to RETURN "gpt-5.5" (trusted because there's no
    // resolveModel at validation time), then have enrichment fail.
    // Easiest: a backend whose only resolveModel always throws. The
    // chain's validateModelOnBackend catches it and treats as
    // invalid → falls through to backend default. So pair it with a
    // matching default to keep the string side stable.
    const be = fakeBackend({
      resolveModel: vi.fn(async () => {
        throw new Error("upstream offline");
      }),
      getDefaultModel: () => "gpt-5.5",
      cacheMetrics: "readwrite",
    });
    const { ref, source } = await resolveActiveModelRefForChat(
      cid,
      be,
      "codex",
      fakeConfig({ backend: "codex" }),
    );
    expect(source).toBe("override-invalid-fallback");
    expect(ref?.id).toBe("gpt-5.5");
    expect(ref?.cacheSupport).toBe("readwrite");
    // bare ref because getModelInfo absent and resolveModel throws
    expect(ref?.displayName).toBe("gpt-5.5");
  });
});

// ── Convenience wrapper ─────────────────────────────────────────────────────

describe("getActiveModelRefForChat", () => {
  it("returns the ref directly", async () => {
    const cid = nextChatId();
    setChatModelForBackend(cid, "codex", "gpt-5.5");
    const be = fakeBackend({
      resolveModel: vi.fn(async () => exact("gpt-5.5")),
      getModelInfo: vi.fn(async (id) => fullInfo({ id })),
    });
    const ref = await getActiveModelRefForChat(cid, be, "codex", fakeConfig());
    expect(ref?.id).toBe("gpt-5.5");
    expect(ref?.backend).toBe("codex");
  });

  it("returns null when the chain produces no model", async () => {
    const cid = nextChatId();
    const be = fakeBackend({
      resolveModel: vi.fn(async () => missing()),
    });
    const ref = await getActiveModelRefForChat(
      cid,
      be,
      "kilo",
      fakeConfig({ backend: "claude" }),
    );
    expect(ref).toBeNull();
  });
});
