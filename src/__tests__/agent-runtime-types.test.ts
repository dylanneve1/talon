/**
 * Phase 1 tests — pure type helpers under `src/core/agent-runtime/`.
 *
 * These pin the small resolver / classifier / policy helpers added in
 * the types-first PR. No legacy backend is touched; no production
 * caller invokes any of the new code yet. The point is to make the
 * shape contract explicit before backend rewrites begin.
 */

import { describe, it, expect } from "vitest";
import {
  addUsage,
  emptyUsage,
  isAgentEventOf,
  isAgentRunTerminator,
  type AgentEvent,
} from "../core/agent-runtime/events.js";
import {
  BACKEND_IDS,
  isBackendId,
  makeBareModelRef,
  sameModelRef,
  type ModelRef,
} from "../core/agent-runtime/model-ref.js";
import { composeBackend } from "../core/agent-runtime/capabilities.js";

// ── events ──────────────────────────────────────────────────────────────────

describe("agent-runtime/events", () => {
  it("emptyUsage returns zeros with no modelId", () => {
    const usage = emptyUsage();
    expect(usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect("modelId" in usage).toBe(false);
  });

  it("addUsage sums all counters", () => {
    const a = {
      inputTokens: 10,
      outputTokens: 20,
      cacheRead: 30,
      cacheWrite: 40,
    };
    const b = {
      inputTokens: 1,
      outputTokens: 2,
      cacheRead: 3,
      cacheWrite: 4,
    };
    expect(addUsage(a, b)).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      cacheRead: 33,
      cacheWrite: 44,
    });
  });

  it("addUsage carries the latest modelId forward when present", () => {
    const a = { ...emptyUsage(), modelId: "claude-opus-4-7" };
    const b = { ...emptyUsage(), modelId: "gpt-5.5" };
    expect(addUsage(a, b).modelId).toBe("gpt-5.5");
  });

  it("addUsage preserves the prior modelId when the right side omits it", () => {
    const a = { ...emptyUsage(), modelId: "claude-opus-4-7" };
    const b = emptyUsage();
    expect(addUsage(a, b).modelId).toBe("claude-opus-4-7");
  });

  it("isAgentEventOf narrows correctly", () => {
    const evt: AgentEvent = { type: "assistant_message", text: "hello" };
    expect(isAgentEventOf(evt, "assistant_message")).toBe(true);
    expect(isAgentEventOf(evt, "completed")).toBe(false);
  });

  it("isAgentRunTerminator covers completed and error", () => {
    expect(
      isAgentRunTerminator({
        type: "completed",
        result: { text: "", durationMs: 0, usage: emptyUsage() },
      }),
    ).toBe(true);
    expect(
      isAgentRunTerminator({
        type: "error",
        error: { kind: "unknown", message: "boom", retryable: false },
      }),
    ).toBe(true);
    expect(isAgentRunTerminator({ type: "run_started" })).toBe(false);
    expect(isAgentRunTerminator({ type: "text_delta", text: "x" })).toBe(false);
  });
});

// ── model-ref ───────────────────────────────────────────────────────────────

describe("agent-runtime/model-ref", () => {
  it("BACKEND_IDS pins the five current backends", () => {
    expect([...BACKEND_IDS].sort()).toEqual([
      "claude",
      "codex",
      "kilo",
      "openai-agents",
      "opencode",
    ]);
  });

  it("isBackendId narrows valid ids", () => {
    expect(isBackendId("claude")).toBe(true);
    expect(isBackendId("codex")).toBe(true);
    expect(isBackendId("openai-agents")).toBe(true);
    expect(isBackendId("kilo")).toBe(true);
    expect(isBackendId("opencode")).toBe(true);
  });

  it("isBackendId rejects unknown ids and non-strings", () => {
    expect(isBackendId("antigravity")).toBe(false);
    expect(isBackendId("CLAUDE")).toBe(false);
    expect(isBackendId("")).toBe(false);
    expect(isBackendId(undefined)).toBe(false);
    expect(isBackendId(null)).toBe(false);
    expect(isBackendId(42)).toBe(false);
    expect(isBackendId({ id: "claude" })).toBe(false);
  });

  it("sameModelRef compares on identity only", () => {
    const a: ModelRef = makeBareModelRef("claude", "claude-opus-4-7");
    const b: ModelRef = {
      ...makeBareModelRef("claude", "claude-opus-4-7"),
      displayName: "Opus 4.7",
      contextWindow: 1_000_000,
    };
    const c: ModelRef = makeBareModelRef("codex", "claude-opus-4-7");
    expect(sameModelRef(a, b)).toBe(true);
    expect(sameModelRef(a, c)).toBe(false);
  });

  it("makeBareModelRef sets sensible defaults", () => {
    const ref = makeBareModelRef("codex", "gpt-5.5");
    expect(ref).toEqual({
      backend: "codex",
      id: "gpt-5.5",
      displayName: "gpt-5.5",
      source: "unknown",
      cacheSupport: "none",
      selectable: true,
    });
  });

  it("makeBareModelRef respects the source override", () => {
    const ref = makeBareModelRef("kilo", "kilo/qwen-2.5-coder", "discovered");
    expect(ref.source).toBe("discovered");
  });
});

// ── capabilities ────────────────────────────────────────────────────────────

describe("agent-runtime/capabilities", () => {
  it("composeBackend leaves omitted slots undefined", () => {
    const backend = composeBackend({
      id: "claude",
      label: "Test",
      chat: { runChatTurn: async function* () {} },
      background: { runOneShotAgent: async () => undefined },
    });
    expect(backend.chat).toBeDefined();
    expect(backend.background).toBeDefined();
    expect(backend.models).toBeUndefined();
    expect(backend.sessions).toBeUndefined();
    expect(backend.tools).toBeUndefined();
    expect(backend.usage).toBeUndefined();
    expect(backend.control).toBeUndefined();
  });

  it("composeBackend defaults cacheMetrics to none", () => {
    const backend = composeBackend({
      id: "claude",
      label: "Test",
      chat: { runChatTurn: async function* () {} },
    });
    expect(backend.cacheMetrics).toBe("none");
  });
});
