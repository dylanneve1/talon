/**
 * Backend contract suite — Phase 7.
 *
 * `core/agent-runtime/contract-tests.ts` holds the assertions every
 * conforming `Backend` must pass. This file is their consumer:
 *
 *   1. a well-behaved backend — a `stubBackend` whose `query` runs
 *      through the production `handlerToEvents` → `composeBackend`
 *      path — passes every assertion, across every shipped
 *      `BackendId`;
 *   2. deliberately-malformed chat streams fail the relevant
 *      assertion with a descriptive `ContractViolation`.
 *
 * (1) pins that the unified `handlerToEvents` → `composeBackend`
 * surface is contract-compliant. (2) pins that the assertions
 * actually catch violations, so a future backend rewrite that breaks
 * the stream shape fails loudly with a source-obvious message rather
 * than passing silently.
 */

import { describe, it, expect } from "vitest";
import {
  assertBackendContract,
  assertBackendIdentity,
  assertBackgroundRunnerLifecycle,
  assertChatBackendCarriesRetrievedMemory,
  assertChatBackendEmitsRunStarted,
  assertChatBackendEmitsSingleUsage,
  assertChatBackendTerminates,
  assertCompletedUsageMatchesUsageEvent,
  assertModelCatalogDefaultShape,
  assertUsageTelemetryShape,
} from "../core/agent-runtime/contract-tests.js";
import { stubBackend } from "./helpers/stub-backend.js";
import {
  composeBackend,
  type Backend,
} from "../core/agent-runtime/capabilities.js";
import type {
  AgentEvent,
  UsageSnapshot,
} from "../core/agent-runtime/events.js";
import {
  BACKEND_IDS,
  type BackendId,
} from "../core/agent-runtime/model-ref.js";
import {
  formatUserPrompt,
  RECALLED_MEMORY_HEADER,
} from "../backend/runtime/prompt/prompt-format.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A backend that conforms to every contract, built the same way
 * production backends are: a callback `query` wrapped by
 * `handlerToEvents` and composed via `composeBackend` (both inside
 * `stubBackend`).
 */
function wellBehaved(id: BackendId = "claude"): Backend {
  return stubBackend({
    id,
    label: `Stub ${id}`,
    cacheMetrics: "readwrite",
    query: async () => ({
      text: "hello",
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 5,
      cacheWrite: 2,
    }),
    runOneShotAgent: async () => undefined,
    getDefaultModel: () => "stub-default",
    getSessionSnapshot: async () => ({
      inputTokens: 1,
      outputTokens: 2,
      cacheRead: 3,
      cacheWrite: 4,
    }),
  });
}

/**
 * A backend wired the way all four production handlers are: the
 * canonical `ChatRunParams` reaches the handler as `QueryParams`, and
 * the handler renders its user prompt with the ONE shared helper. That
 * is the whole seam per-turn memory travels down, so capturing the
 * helper's output here is capturing "the prompt the backend sends".
 */
function promptCapturing(id: BackendId = "claude"): {
  backend: Backend;
  capturePrompt: () => string | undefined;
} {
  let prompt: string | undefined;
  const backend = stubBackend({
    id,
    query: async (params) => {
      prompt = formatUserPrompt({
        text: params.text,
        senderName: params.senderName,
        senderHandle: params.senderHandle,
        isGroup: params.isGroup,
        messageId: params.messageId,
        retrievedMemory: params.retrievedMemory,
      });
      return {
        text: "hello",
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheRead: 0,
        cacheWrite: 0,
      };
    },
  });
  return { backend, capturePrompt: () => prompt };
}

async function* streamOf(...events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}

/** A backend whose chat stream is whatever the test dictates. */
function badChat(events: AgentEvent[]): Backend {
  return composeBackend({
    id: "claude",
    label: "Bad Stub",
    cacheMetrics: "none",
    chat: { runChatTurn: () => streamOf(...events) },
  });
}

const USAGE: UsageSnapshot = {
  inputTokens: 1,
  outputTokens: 2,
  cacheRead: 0,
  cacheWrite: 0,
  modelId: "m",
};

// ── Happy path — composed stub passes every contract ──────────────────────────

describe("backend contract / well-behaved stub", () => {
  const backend = wellBehaved();

  it("identity matches the expected BackendId", () => {
    expect(() => assertBackendIdentity(backend, "claude")).not.toThrow();
  });

  it("passes the full suite and reports every checked contract", async () => {
    const checked = await assertBackendContract(backend);
    expect(checked).toEqual(
      expect.arrayContaining([
        "ChatBackend.emitsRunStarted",
        "ChatBackend.terminates",
        "ChatBackend.singleUsage",
        "ChatBackend.completedUsageMatches",
        "BackgroundRunner.lifecycle",
        "ModelCatalog.defaultShape",
        "UsageTelemetry.shape",
      ]),
    );
  });

  it("passes each individual assertion", async () => {
    await expect(
      assertChatBackendEmitsRunStarted(backend),
    ).resolves.not.toThrow();
    await expect(assertChatBackendTerminates(backend)).resolves.not.toThrow();
    await expect(
      assertChatBackendEmitsSingleUsage(backend),
    ).resolves.not.toThrow();
    await expect(
      assertCompletedUsageMatchesUsageEvent(backend),
    ).resolves.not.toThrow();
    await expect(
      assertBackgroundRunnerLifecycle(backend),
    ).resolves.not.toThrow();
    await expect(
      assertModelCatalogDefaultShape(backend),
    ).resolves.not.toThrow();
    await expect(assertUsageTelemetryShape(backend)).resolves.not.toThrow();
  });
});

// ── Every shipped backend id conforms through the wrapper ─────────────────────

describe("backend contract / across every BackendId", () => {
  for (const id of BACKEND_IDS) {
    it(`${id}: composed stub passes the full contract`, async () => {
      const checked = await assertBackendContract(wellBehaved(id));
      expect(checked).toContain("ChatBackend.terminates");
    });

    it(`${id}: carries per-turn retrieved memory into the user prompt`, async () => {
      const { backend, capturePrompt } = promptCapturing(id);
      const checked = await assertBackendContract(backend, { capturePrompt });
      expect(checked).toContain("ChatBackend.carriesRetrievedMemory");
    });
  }
});

// ── Turn retrieval — the seam #639 deleted, rebuilt without divergence ────────

describe("backend contract / retrieved memory reaches the user turn", () => {
  it("renders the verify-first block after the message text", async () => {
    const { backend, capturePrompt } = promptCapturing();
    await assertChatBackendCarriesRetrievedMemory(backend, capturePrompt, {
      text: "what did I say about the cache?",
      marker: "#7 [fact] cache: the TTL knob does not exist",
    });
    const prompt = capturePrompt() ?? "";
    // The last run the assertion made carried no memory — byte-identical
    // to a pre-retrieval prompt.
    expect(prompt).not.toContain(RECALLED_MEMORY_HEADER);
  });

  it("a backend that drops the field fails the clause", async () => {
    let prompt: string | undefined;
    const backend = stubBackend({
      query: async (params) => {
        // The #639 shape: the field arrives and is silently ignored.
        prompt = formatUserPrompt({
          text: params.text,
          senderName: params.senderName,
        });
        return {
          text: "hello",
          durationMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        };
      },
    });
    await expect(
      assertChatBackendCarriesRetrievedMemory(backend, () => prompt),
    ).rejects.toThrow(/violates contract "ChatBackend.carriesRetrievedMemory"/);
  });
});

// ── Failure path — assertions catch violations ────────────────────────────────

describe("backend contract / malformed streams fail loudly", () => {
  it("missing run_started → emitsRunStarted throws ContractViolation", async () => {
    const backend = badChat([
      { type: "usage", usage: USAGE },
      {
        type: "completed",
        result: { text: "", durationMs: 0, usage: USAGE, modelId: "m" },
      },
    ]);
    await expect(assertChatBackendEmitsRunStarted(backend)).rejects.toThrow(
      /violates contract "ChatBackend.emitsRunStarted"/,
    );
  });

  it("no terminator → terminates throws ContractViolation", async () => {
    const backend = badChat([
      { type: "run_started" },
      { type: "text_delta", text: "hi" },
    ]);
    await expect(assertChatBackendTerminates(backend)).rejects.toThrow(
      /violates contract "ChatBackend.terminates"/,
    );
  });

  it("two usage events → singleUsage throws ContractViolation", async () => {
    const backend = badChat([
      { type: "run_started" },
      { type: "usage", usage: USAGE },
      { type: "usage", usage: USAGE },
      {
        type: "completed",
        result: { text: "", durationMs: 0, usage: USAGE, modelId: "m" },
      },
    ]);
    await expect(assertChatBackendEmitsSingleUsage(backend)).rejects.toThrow(
      /violates contract "ChatBackend.singleUsage"/,
    );
  });

  it("completed.usage disagrees with the usage event → completedUsageMatches throws", async () => {
    const backend = badChat([
      { type: "run_started" },
      { type: "usage", usage: USAGE },
      {
        type: "completed",
        result: {
          text: "",
          durationMs: 0,
          usage: { ...USAGE, outputTokens: 999 },
          modelId: "m",
        },
      },
    ]);
    await expect(
      assertCompletedUsageMatchesUsageEvent(backend),
    ).rejects.toThrow(/violates contract "ChatBackend.completedUsageMatches"/);
  });
});
