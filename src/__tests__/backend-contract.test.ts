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
  }
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
