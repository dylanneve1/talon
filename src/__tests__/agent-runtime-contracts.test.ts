/**
 * Phase 7 prep tests — Backend contract assertions self-test.
 *
 * Validates that every contract helper in
 * `core/agent-runtime/contract-tests.ts` PASSES against a
 * known-good backend (the adapter wrapping a well-behaved stub)
 * AND FAILS with a clear error against a deliberately-bad backend.
 *
 * If a future backend rewrite breaks one of these contracts, the
 * test for that backend will fail with the same descriptive
 * `ContractViolation` message — making the regression's source
 * obvious without test-side tweaking.
 */

import { describe, it, expect, vi } from "vitest";
import {
  assertBackendContract,
  assertBackendIdentity,
  assertBackgroundRunnerLifecycle,
  assertChatBackendEmitsRunStarted,
  assertChatBackendEmitsSingleUsage,
  assertChatBackendTerminates,
  assertCompletedUsageMatchesUsageEvent,
  assertModelCatalogDefaultShape,
  assertUsageTelemetryShape,
} from "../core/agent-runtime/contract-tests.js";
import { adaptQueryBackend } from "../core/agent-runtime/adapter.js";
import type {
  Backend,
  ChatBackend,
} from "../core/agent-runtime/capabilities.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";
import { makeBareModelRef } from "../core/agent-runtime/model-ref.js";
import type { QueryBackend } from "../core/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function wellBehavedLegacy(): QueryBackend {
  return {
    query: vi.fn(async () => ({
      text: "hello",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 5,
      cacheWrite: 2,
    })),
    runOneShotAgent: vi.fn(async () => undefined),
    cacheMetrics: "readwrite",
    // resolveModel needs to be present for the adapter to populate
    // the `models` capability slot at all — otherwise the
    // ModelCatalog contract isn't exercised.
    resolveModel: async (id: string) => ({
      kind: "exact" as const,
      storedValue: id,
      model: {
        id,
        displayName: id,
        provider: "stub",
        providerName: "Stub",
        selectable: true,
      },
    }),
    getDefaultModel: () => "stub-default",
    getModelInfo: async (id: string) => ({
      id,
      displayName: id,
      provider: "stub",
      providerName: "Stub",
      selectable: true,
    }),
    getSessionSnapshot: async () => ({
      inputTokens: 1,
      outputTokens: 2,
      cacheRead: 3,
      cacheWrite: 4,
    }),
  } as QueryBackend;
}

function makeBadChatBackend(
  generator: () => AsyncIterable<AgentEvent>,
): Backend {
  const chat: ChatBackend = {
    runChatTurn: () => generator(),
  };
  return {
    id: "claude",
    label: "Bad Stub",
    capabilities: {
      chat: true,
      background: false,
      models: false,
      sessions: false,
      tools: false,
      usage: false,
    },
    chat,
  };
}

// ── Happy path — adapter-wrapped stub passes every contract ────────────────

describe("contract helpers / well-behaved adapter", () => {
  const backend = adaptQueryBackend(
    wellBehavedLegacy(),
    "claude",
    "Claude SDK",
  );

  it("identity matches the expected BackendId", () => {
    expect(() => assertBackendIdentity(backend, "claude")).not.toThrow();
  });

  it("chat backend emits run_started first", async () => {
    await expect(
      assertChatBackendEmitsRunStarted(backend),
    ).resolves.not.toThrow();
  });

  it("chat backend terminates with completed", async () => {
    await expect(assertChatBackendTerminates(backend)).resolves.not.toThrow();
  });

  it("chat backend emits exactly one usage event", async () => {
    await expect(
      assertChatBackendEmitsSingleUsage(backend),
    ).resolves.not.toThrow();
  });

  it("completed.result.usage matches usage event", async () => {
    await expect(
      assertCompletedUsageMatchesUsageEvent(backend),
    ).resolves.not.toThrow();
  });

  it("background runner emits the lifecycle", async () => {
    await expect(
      assertBackgroundRunnerLifecycle(backend),
    ).resolves.not.toThrow();
  });

  it("model catalog returns a same-backend default", async () => {
    await expect(
      assertModelCatalogDefaultShape(backend),
    ).resolves.not.toThrow();
  });

  it("usage telemetry returns finite non-negative numbers", async () => {
    await expect(assertUsageTelemetryShape(backend)).resolves.not.toThrow();
  });

  it("assertBackendContract covers all populated capabilities", async () => {
    const checked = await assertBackendContract(backend);
    expect(checked).toEqual([
      "ChatBackend.emitsRunStarted",
      "ChatBackend.terminates",
      "ChatBackend.singleUsage",
      "ChatBackend.completedUsageMatches",
      "BackgroundRunner.lifecycle",
      "ModelCatalog.defaultShape",
      "UsageTelemetry.shape",
    ]);
  });
});

// ── Identity contract ──────────────────────────────────────────────────────

describe("assertBackendIdentity", () => {
  it("throws when id does not match expected", () => {
    const backend = adaptQueryBackend(wellBehavedLegacy(), "claude", "Claude");
    expect(() => assertBackendIdentity(backend, "codex")).toThrow(
      /expected id "codex", got "claude"/,
    );
  });

  it("throws when label is empty", () => {
    const backend = adaptQueryBackend(wellBehavedLegacy(), "claude", "");
    expect(() => assertBackendIdentity(backend, "claude")).toThrow(
      /label.*non-empty/,
    );
  });
});

// ── Negative tests — contract helpers catch violations ─────────────────────

describe("assertChatBackendEmitsRunStarted / negative", () => {
  it("throws when first event is not run_started", async () => {
    const bad = makeBadChatBackend(async function* () {
      yield { type: "assistant_message", text: "no run_started" };
      yield {
        type: "completed",
        result: {
          text: "x",
          durationMs: 1,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      };
    });
    await expect(assertChatBackendEmitsRunStarted(bad)).rejects.toThrow(
      /first event was assistant_message/,
    );
  });
});

describe("assertChatBackendTerminates / negative", () => {
  it("throws when stream ends on text_delta", async () => {
    const bad = makeBadChatBackend(async function* () {
      yield { type: "run_started" };
      yield { type: "text_delta", text: "leaked" };
    });
    await expect(assertChatBackendTerminates(bad)).rejects.toThrow(
      /stream ended on text_delta/,
    );
  });
});

describe("assertChatBackendEmitsSingleUsage / negative", () => {
  it("throws when zero usage events fire on successful completion", async () => {
    const bad = makeBadChatBackend(async function* () {
      yield { type: "run_started" };
      yield { type: "assistant_message", text: "x" };
      yield {
        type: "completed",
        result: {
          text: "x",
          durationMs: 1,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      };
    });
    await expect(assertChatBackendEmitsSingleUsage(bad)).rejects.toThrow(
      /emitted no usage event/,
    );
  });

  it("throws when multiple usage events fire on success", async () => {
    const bad = makeBadChatBackend(async function* () {
      yield { type: "run_started" };
      yield {
        type: "usage",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
      yield {
        type: "usage",
        usage: {
          inputTokens: 2,
          outputTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
      yield {
        type: "completed",
        result: {
          text: "x",
          durationMs: 1,
          usage: {
            inputTokens: 2,
            outputTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      };
    });
    await expect(assertChatBackendEmitsSingleUsage(bad)).rejects.toThrow(
      /emitted 2 usage events/,
    );
  });
});

describe("assertCompletedUsageMatchesUsageEvent / negative", () => {
  it("throws when completed.result.usage disagrees with the usage event", async () => {
    const bad = makeBadChatBackend(async function* () {
      yield { type: "run_started" };
      yield {
        type: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheRead: 0,
          cacheWrite: 0,
        },
      };
      yield {
        type: "completed",
        result: {
          text: "x",
          durationMs: 1,
          usage: {
            inputTokens: 999, // ← mismatch
            outputTokens: 20,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      };
    });
    await expect(assertCompletedUsageMatchesUsageEvent(bad)).rejects.toThrow(
      /usage event.*completed.result.usage/,
    );
  });
});

describe("assertBackgroundRunnerLifecycle / negative", () => {
  it("throws when stream ends on warning instead of completed/error", async () => {
    const backend: Backend = {
      id: "claude",
      label: "Bad",
      capabilities: {
        chat: false,
        background: true,
        models: false,
        sessions: false,
        tools: false,
        usage: false,
      },
      background: {
        runBackgroundTask: async function* () {
          yield { type: "run_started" };
          yield { type: "warning", message: "lol" };
        },
      },
    };
    await expect(assertBackgroundRunnerLifecycle(backend)).rejects.toThrow(
      /stream ended on warning/,
    );
  });
});

describe("assertModelCatalogDefaultShape / negative", () => {
  it("throws when getDefaultModel returns a ref for a different backend", async () => {
    const backend: Backend = {
      id: "claude",
      label: "Bad",
      capabilities: {
        chat: false,
        background: false,
        models: true,
        sessions: false,
        tools: false,
        usage: false,
      },
      models: {
        resolveModel: async () => ({ kind: "missing" }),
        listModels: async () => ({ models: [], total: 0 }),
        getDefaultModel: async () => makeBareModelRef("codex", "foreign-id"),
      },
    };
    await expect(assertModelCatalogDefaultShape(backend)).rejects.toThrow(
      /ref for backend "codex".*expected "claude"/,
    );
  });

  it("throws when getDefaultModel throws", async () => {
    const backend: Backend = {
      id: "claude",
      label: "Bad",
      capabilities: {
        chat: false,
        background: false,
        models: true,
        sessions: false,
        tools: false,
        usage: false,
      },
      models: {
        resolveModel: async () => ({ kind: "missing" }),
        listModels: async () => ({ models: [], total: 0 }),
        getDefaultModel: async () => {
          throw new Error("upstream offline");
        },
      },
    };
    await expect(assertModelCatalogDefaultShape(backend)).rejects.toThrow(
      /threw: upstream offline/,
    );
  });
});

describe("assertUsageTelemetryShape / negative", () => {
  it("throws on negative counter", async () => {
    const backend: Backend = {
      id: "claude",
      label: "Bad",
      capabilities: {
        chat: false,
        background: false,
        models: false,
        sessions: false,
        tools: false,
        usage: true,
      },
      usage: {
        getSessionSnapshot: async () => ({
          inputTokens: -1,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }),
      },
    };
    await expect(assertUsageTelemetryShape(backend)).rejects.toThrow(
      /inputTokens was negative/,
    );
  });

  it("throws on NaN counter", async () => {
    const backend: Backend = {
      id: "claude",
      label: "Bad",
      capabilities: {
        chat: false,
        background: false,
        models: false,
        sessions: false,
        tools: false,
        usage: true,
      },
      usage: {
        getSessionSnapshot: async () => ({
          inputTokens: 1,
          outputTokens: 2,
          cacheRead: 3,
          cacheWrite: Number.NaN,
        }),
      },
    };
    await expect(assertUsageTelemetryShape(backend)).rejects.toThrow(
      /cacheWrite was non-finite/,
    );
  });

  it("accepts undefined snapshot as a valid response", async () => {
    const backend: Backend = {
      id: "claude",
      label: "OK",
      capabilities: {
        chat: false,
        background: false,
        models: false,
        sessions: false,
        tools: false,
        usage: true,
      },
      usage: {
        getSessionSnapshot: async () => undefined,
      },
    };
    await expect(assertUsageTelemetryShape(backend)).resolves.not.toThrow();
  });
});
