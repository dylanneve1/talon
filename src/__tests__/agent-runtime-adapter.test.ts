/**
 * Phase 1 tests — the legacy-`QueryBackend` → `Backend` adapter.
 *
 * The adapter is the bridge across the new shape: production callers
 * keep talking to `QueryBackend` while migration is in flight, and
 * Phase 3 native backends will start emitting `AgentEvent`s directly.
 * These tests pin every translation rule so the bridge doesn't
 * silently drift.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  CacheMetricsSupport,
  OneShotAgentParams,
  QueryBackend,
  QueryParams,
  QueryResult,
  UnifiedModelInfo,
  UnifiedModelResolution,
} from "../core/types.js";
import { adaptQueryBackend } from "../core/agent-runtime/adapter.js";
import type { AgentEvent, AgentResult } from "../core/agent-runtime/events.js";
import { makeBareModelRef } from "../core/agent-runtime/model-ref.js";
import { defaultRunPolicyFor } from "../core/agent-runtime/run-policy.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function stubModelInfo(
  overrides: Partial<UnifiedModelInfo> = {},
): UnifiedModelInfo {
  return {
    id: "stub-model",
    displayName: "Stub Model",
    provider: "stub",
    providerName: "Stub Provider",
    selectable: true,
    free: false,
    contextWindow: 200_000,
    reasoning: true,
    supportedReasoningLevels: ["low", "medium", "high"],
    defaultReasoningLevel: "medium",
    ...overrides,
  };
}

function stubQueryResult(overrides: Partial<QueryResult> = {}): QueryResult {
  return {
    text: "hello world",
    durationMs: 1234,
    inputTokens: 100,
    outputTokens: 50,
    cacheRead: 25,
    cacheWrite: 5,
    ...overrides,
  };
}

function makeStubBackend(overrides: Partial<QueryBackend> = {}): QueryBackend {
  return {
    query: vi.fn(async (_params: QueryParams) => stubQueryResult()),
    cacheMetrics: "readwrite" as CacheMetricsSupport,
    ...overrides,
  } as QueryBackend;
}

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

// ── Construction ────────────────────────────────────────────────────────────

describe("adaptQueryBackend / construction", () => {
  it("rejects unknown backend ids", () => {
    const legacy = makeStubBackend();
    expect(() =>
      adaptQueryBackend(legacy, "not-a-backend" as never, "Not A Backend"),
    ).toThrow(/not a known BackendId/);
  });

  it("populates only the slots the legacy backend implements", () => {
    const legacy = makeStubBackend();
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    expect(adapted.capabilities).toEqual({
      chat: true,
      background: false,
      models: false,
      sessions: false,
      tools: false,
      usage: false,
    });
    expect(adapted.chat).toBeDefined();
    expect(adapted.background).toBeUndefined();
    expect(adapted.models).toBeUndefined();
    expect(adapted.sessions).toBeUndefined();
    expect(adapted.tools).toBeUndefined();
    expect(adapted.usage).toBeUndefined();
  });

  it("flips capability flags as legacy methods become present", () => {
    const legacy = makeStubBackend({
      runOneShotAgent: vi.fn(async () => undefined),
      resolveModel: vi.fn(
        async () => ({ kind: "missing" }) as UnifiedModelResolution,
      ),
      resetChat: vi.fn(),
      refreshMcpServers: vi.fn(async () => ({
        added: [],
        removed: [],
        errors: {},
      })),
      getSessionSnapshot: vi.fn(async () => ({ inputTokens: 1 })),
    });
    const adapted = adaptQueryBackend(legacy, "codex", "Codex");
    expect(adapted.capabilities).toEqual({
      chat: true,
      background: true,
      models: true,
      sessions: true,
      tools: true,
      usage: true,
    });
  });
});

// ── Chat shim ───────────────────────────────────────────────────────────────

describe("adaptQueryBackend / chat", () => {
  it("emits run_started → assistant_message → usage → completed on success", async () => {
    const legacy = makeStubBackend();
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    const events = await collect(
      adapted.chat!.runChatTurn({
        chatId: "42",
        model: makeBareModelRef("claude", "claude-opus-4-7"),
        policy: defaultRunPolicyFor("chat"),
        text: "hi",
        senderName: "Dylan",
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "assistant_message",
      "usage",
      "completed",
    ]);
    const completed = events.at(-1) as Extract<
      AgentEvent,
      { type: "completed" }
    >;
    const result = completed.result as AgentResult;
    expect(result.text).toBe("hello world");
    expect(result.durationMs).toBe(1234);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheRead: 25,
      cacheWrite: 5,
      modelId: "claude-opus-4-7",
    });
  });

  it("passes the resolved model id through to the legacy backend", async () => {
    const queryFn = vi.fn(async (_p: QueryParams) => stubQueryResult());
    const legacy = makeStubBackend({ query: queryFn });
    const adapted = adaptQueryBackend(legacy, "codex", "Codex");
    await collect(
      adapted.chat!.runChatTurn({
        chatId: "abc",
        model: makeBareModelRef("codex", "gpt-5.5"),
        policy: defaultRunPolicyFor("chat"),
        text: "hi",
        senderName: "Dylan",
        isGroup: true,
        messageId: 99,
      }),
    );
    expect(queryFn).toHaveBeenCalledTimes(1);
    const arg = queryFn.mock.calls[0]![0];
    expect(arg.chatId).toBe("abc");
    expect(arg.model).toBe("gpt-5.5");
    expect(arg.isGroup).toBe(true);
    expect(arg.messageId).toBe(99);
    expect(arg.senderName).toBe("Dylan");
  });

  it("omits assistant_message when the response is empty", async () => {
    const legacy = makeStubBackend({
      query: vi.fn(async () => stubQueryResult({ text: "" })),
    });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    const events = await collect(
      adapted.chat!.runChatTurn({
        chatId: "1",
        model: makeBareModelRef("claude", "claude-opus-4-7"),
        policy: defaultRunPolicyFor("chat"),
        text: "ping",
        senderName: "Dylan",
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "usage",
      "completed",
    ]);
  });

  it("emits an error event when query throws", async () => {
    const legacy = makeStubBackend({
      query: vi.fn(async () => {
        throw new Error("rate limit exceeded — try again");
      }),
    });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    const events = await collect(
      adapted.chat!.runChatTurn({
        chatId: "1",
        model: makeBareModelRef("claude", "claude-opus-4-7"),
        policy: defaultRunPolicyFor("chat"),
        text: "hi",
        senderName: "Dylan",
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["run_started", "error"]);
    const err = events[1] as Extract<AgentEvent, { type: "error" }>;
    expect(err.error.kind).toBe("rate_limit");
    expect(err.error.retryable).toBe(true);
    expect(err.error.message).toMatch(/rate limit/i);
  });

  it("classifies abort as kind=aborted, retryable=false", async () => {
    const legacy = makeStubBackend({
      query: vi.fn(async () => {
        throw new Error("operation aborted");
      }),
    });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    const events = await collect(
      adapted.chat!.runChatTurn({
        chatId: "1",
        model: makeBareModelRef("claude", "claude-opus-4-7"),
        policy: defaultRunPolicyFor("chat"),
        text: "hi",
        senderName: "Dylan",
      }),
    );
    const err = events.at(-1) as Extract<AgentEvent, { type: "error" }>;
    expect(err.error.kind).toBe("aborted");
    expect(err.error.retryable).toBe(false);
  });
});

// ── Background shim ─────────────────────────────────────────────────────────

describe("adaptQueryBackend / background", () => {
  it("forwards appendLog through the optional logSink", async () => {
    const sink = vi.fn();
    const legacy = makeStubBackend({
      runOneShotAgent: vi.fn(async (params: OneShotAgentParams) => {
        await params.appendLog("step 1\n");
        await params.appendLog("step 2\n");
      }),
    });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude", {
      logSink: sink,
    });
    const events = await collect(
      adapted.background!.runBackgroundTask({
        prompt: "ping",
        systemPrompt: "",
        workspace: "/tmp",
        model: makeBareModelRef("claude", "claude-opus-4-7"),
        policy: defaultRunPolicyFor("heartbeat"),
        contextLabel: "heartbeat",
        abortController: new AbortController(),
      }),
    );
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenNthCalledWith(1, "step 1\n");
    expect(sink).toHaveBeenNthCalledWith(2, "step 2\n");
    expect(events.map((e) => e.type)).toEqual(["run_started", "completed"]);
  });

  it("emits an error event when the legacy one-shot throws", async () => {
    const legacy = makeStubBackend({
      runOneShotAgent: vi.fn(async () => {
        throw new Error("context length exceeded — model bailed");
      }),
    });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    const events = await collect(
      adapted.background!.runBackgroundTask({
        prompt: "ping",
        systemPrompt: "",
        workspace: "/tmp",
        model: makeBareModelRef("claude", "claude-opus-4-7"),
        policy: defaultRunPolicyFor("dream"),
        contextLabel: "dream",
        abortController: new AbortController(),
      }),
    );
    expect(events.map((e) => e.type)).toEqual(["run_started", "error"]);
    const err = events[1] as Extract<AgentEvent, { type: "error" }>;
    expect(err.error.kind).toBe("context_overflow");
  });

  it("emits a synthetic error when the legacy backend has no runOneShotAgent", async () => {
    const legacy = makeStubBackend({ runOneShotAgent: undefined });
    // No background slot when the legacy method is absent — adapter must
    // omit the capability entirely rather than silently lie.
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    expect(adapted.background).toBeUndefined();
  });
});

// ── Catalog shim ────────────────────────────────────────────────────────────

describe("adaptQueryBackend / models", () => {
  it("translates exact resolutions into a ModelRef", async () => {
    const info = stubModelInfo({ id: "claude-opus-4-7" });
    const legacy = makeStubBackend({
      cacheMetrics: "readwrite",
      resolveModel: vi.fn(
        async (): Promise<UnifiedModelResolution> => ({
          kind: "exact",
          model: info,
          storedValue: "claude-opus-4-7",
        }),
      ),
    });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    const resolution = await adapted.models!.resolveModel(
      "claude-opus-4-7",
      {},
    );
    expect(resolution.kind).toBe("exact");
    if (resolution.kind !== "exact") throw new Error("unreachable");
    expect(resolution.storedValue).toBe("claude-opus-4-7");
    expect(resolution.model).toMatchObject({
      backend: "claude",
      id: "claude-opus-4-7",
      displayName: "Stub Model",
      provider: "stub",
      contextWindow: 200_000,
      cacheSupport: "readwrite",
      selectable: true,
      source: "discovered",
      effortLevels: ["low", "medium", "high"],
      defaultEffort: "medium",
    });
  });

  it("passes through ambiguous + missing kinds", async () => {
    const legacy = makeStubBackend({
      resolveModel: vi
        .fn()
        .mockResolvedValueOnce({
          kind: "ambiguous",
          matches: [stubModelInfo({ id: "a" }), stubModelInfo({ id: "b" })],
        } as UnifiedModelResolution)
        .mockResolvedValueOnce({ kind: "missing" } as UnifiedModelResolution),
    });
    const adapted = adaptQueryBackend(legacy, "kilo", "Kilo");
    const ambiguous = await adapted.models!.resolveModel("a", {});
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind === "ambiguous") {
      expect(ambiguous.matches.map((m) => m.id)).toEqual(["a", "b"]);
    }
    const missing = await adapted.models!.resolveModel("nope", {});
    expect(missing.kind).toBe("missing");
  });

  it("respects ModelFilter.selectableOnly + query in listModels", async () => {
    const legacy = makeStubBackend({
      resolveModel: vi.fn(
        async () => ({ kind: "missing" }) as UnifiedModelResolution,
      ),
      listModels: vi.fn(async () => ({
        models: [
          stubModelInfo({ id: "a", displayName: "Alpha", selectable: true }),
          stubModelInfo({ id: "b", displayName: "Beta", selectable: false }),
          stubModelInfo({
            id: "alpha-beta",
            displayName: "alpha-beta",
            selectable: true,
          }),
        ],
        total: 3,
      })),
    });
    const adapted = adaptQueryBackend(legacy, "openai-agents", "OpenAI Agents");
    const onlySelectable = await adapted.models!.listModels({
      selectableOnly: true,
    });
    expect(onlySelectable.models.map((m) => m.id).sort()).toEqual([
      "a",
      "alpha-beta",
    ]);
    expect(onlySelectable.total).toBe(3);
    const queried = await adapted.models!.listModels({ query: "alpha" });
    expect(queried.models.map((m) => m.id).sort()).toEqual(["a", "alpha-beta"]);
  });

  it("getDefaultModel returns null when the legacy default is empty", async () => {
    const legacy = makeStubBackend({
      resolveModel: vi.fn(
        async () => ({ kind: "missing" }) as UnifiedModelResolution,
      ),
      getDefaultModel: vi.fn(async () => null),
    });
    const adapted = adaptQueryBackend(legacy, "kilo", "Kilo");
    const def = await adapted.models!.getDefaultModel({});
    expect(def).toBeNull();
  });

  it("getDefaultModel enriches via getModelInfo when present", async () => {
    const legacy = makeStubBackend({
      resolveModel: vi.fn(
        async () => ({ kind: "missing" }) as UnifiedModelResolution,
      ),
      getDefaultModel: vi.fn(async () => "gpt-5.5"),
      getModelInfo: vi.fn(async () =>
        stubModelInfo({
          id: "gpt-5.5",
          displayName: "GPT-5.5",
          provider: "openai",
        }),
      ),
      cacheMetrics: "read",
    });
    const adapted = adaptQueryBackend(legacy, "codex", "Codex");
    const def = await adapted.models!.getDefaultModel({});
    expect(def).toMatchObject({
      backend: "codex",
      id: "gpt-5.5",
      displayName: "GPT-5.5",
      source: "backend-default",
      cacheSupport: "read",
    });
  });

  it("getDefaultModel returns a bare ref when getModelInfo is absent", async () => {
    const legacy = makeStubBackend({
      resolveModel: vi.fn(
        async () => ({ kind: "missing" }) as UnifiedModelResolution,
      ),
      getDefaultModel: vi.fn(async () => "stub-id"),
      cacheMetrics: "none",
    });
    const adapted = adaptQueryBackend(legacy, "kilo", "Kilo");
    const def = await adapted.models!.getDefaultModel({});
    expect(def).toEqual({
      backend: "kilo",
      id: "stub-id",
      displayName: "stub-id",
      source: "backend-default",
      cacheSupport: "none",
      selectable: true,
    });
  });
});

// ── Sessions / tools / usage ────────────────────────────────────────────────

describe("adaptQueryBackend / sessions, tools, usage", () => {
  it("resetChat + warmSession proxy to the legacy backend", async () => {
    const resetChat = vi.fn();
    const warmSession = vi.fn(async () => undefined);
    const legacy = makeStubBackend({ resetChat, warmSession });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    adapted.sessions!.resetChat("chat-1");
    await adapted.sessions!.warmSession!("chat-1");
    expect(resetChat).toHaveBeenCalledWith("chat-1");
    expect(warmSession).toHaveBeenCalledWith("chat-1");
  });

  it("refreshTools proxies refreshMcpServers", async () => {
    const refreshMcpServers = vi.fn(async () => ({
      added: ["plugin-a"],
      removed: ["plugin-b"],
      errors: {},
    }));
    const legacy = makeStubBackend({ refreshMcpServers });
    const adapted = adaptQueryBackend(legacy, "claude", "Claude");
    const result = await adapted.tools!.refreshTools("chat-1");
    expect(refreshMcpServers).toHaveBeenCalledWith("chat-1");
    expect(result?.added).toEqual(["plugin-a"]);
  });

  it("getSessionSnapshot maps modelId and zero-fills missing counters", async () => {
    const legacy = makeStubBackend({
      getSessionSnapshot: vi.fn(async () => ({
        inputTokens: 42,
        contextModelId: "gpt-5.5",
      })),
    });
    const adapted = adaptQueryBackend(legacy, "codex", "Codex");
    const snapshot = await adapted.usage!.getSessionSnapshot("session-1");
    expect(snapshot).toEqual({
      inputTokens: 42,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      modelId: "gpt-5.5",
    });
  });

  it("getSessionSnapshot returns undefined when the legacy backend does", async () => {
    const legacy = makeStubBackend({
      getSessionSnapshot: vi.fn(async () => undefined),
    });
    const adapted = adaptQueryBackend(legacy, "codex", "Codex");
    expect(
      await adapted.usage!.getSessionSnapshot("session-1"),
    ).toBeUndefined();
  });
});
