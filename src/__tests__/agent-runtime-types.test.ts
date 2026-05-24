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
import {
  allowsDelivery,
  defaultRunPolicyFor,
  requiresAmbientChat,
  type RunKind,
} from "../core/agent-runtime/run-policy.js";
import {
  applyToolFilter,
  type ToolDescriptor,
} from "../core/agent-runtime/tool-descriptor.js";
import { deriveCapabilities } from "../core/agent-runtime/capabilities.js";

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

// ── run-policy ──────────────────────────────────────────────────────────────

describe("agent-runtime/run-policy", () => {
  const kinds: RunKind[] = ["chat", "heartbeat", "dream", "trigger", "test"];

  it("defaultRunPolicyFor returns the requested kind and a matching label", () => {
    for (const kind of kinds) {
      const policy = defaultRunPolicyFor(kind);
      expect(policy.kind).toBe(kind);
      expect(policy.label).toBe(kind);
    }
  });

  it("chat policy allows ambient delivery and a persistent session", () => {
    const policy = defaultRunPolicyFor("chat");
    expect(allowsDelivery(policy)).toBe(true);
    expect(requiresAmbientChat(policy)).toBe(true);
    expect(policy.session.persistent).toBe(true);
    expect(policy.tools.requireExplicitChatId).toBe(false);
    expect(policy.logging.destination).toBe("inline");
  });

  it("heartbeat policy needs explicit chat_id on delivery tools", () => {
    const policy = defaultRunPolicyFor("heartbeat");
    expect(allowsDelivery(policy)).toBe(true);
    expect(requiresAmbientChat(policy)).toBe(false);
    expect(policy.session.persistent).toBe(false);
    expect(policy.tools.requireExplicitChatId).toBe(true);
    expect(policy.logging.destination).toBe("journal");
    expect(policy.timeout.hardMs).toBeGreaterThan(0);
  });

  it("dream policy refuses delivery and filters out ambient-chat tools", () => {
    const policy = defaultRunPolicyFor("dream");
    expect(allowsDelivery(policy)).toBe(false);
    expect(requiresAmbientChat(policy)).toBe(false);
    expect(policy.tools.filter?.excludeDelivery).toBe(true);
    expect(policy.tools.filter?.excludeAmbientChatTools).toBe(true);
    expect(policy.logging.destination).toBe("dreamLog");
  });

  it("trigger policy mirrors heartbeat shape but logs inline", () => {
    const policy = defaultRunPolicyFor("trigger");
    expect(policy.delivery.mode).toBe("explicit");
    expect(policy.tools.requireExplicitChatId).toBe(true);
    expect(policy.logging.destination).toBe("inline");
    expect(policy.session.persistent).toBe(false);
  });

  it("test policy is delivery-locked and tight on timeout", () => {
    const policy = defaultRunPolicyFor("test");
    expect(policy.delivery.mode).toBe("none");
    expect(policy.timeout.hardMs).toBeLessThanOrEqual(60_000);
    expect(policy.session.persistent).toBe(false);
  });
});

// ── tool-descriptor ─────────────────────────────────────────────────────────

describe("agent-runtime/tool-descriptor", () => {
  const tools: ToolDescriptor[] = [
    {
      id: "mcp__telegram-tools__end_turn",
      server: "telegram-tools",
      name: "end_turn",
      tags: ["messaging", "delivery"],
      delivery: true,
      requiresAmbientChat: true,
    },
    {
      id: "mcp__telegram-tools__react",
      server: "telegram-tools",
      name: "react",
      tags: ["messaging", "delivery"],
      delivery: true,
      requiresAmbientChat: true,
    },
    {
      id: "mcp__mempalace-tools__mempalace_search",
      server: "mempalace-tools",
      name: "mempalace_search",
      tags: ["memory", "readonly"],
      readOnly: true,
    },
    {
      id: "Bash",
      name: "Bash",
      tags: ["shell"],
    },
  ];

  it("returns a copy of the list when no filter is given", () => {
    const out = applyToolFilter(tools, undefined);
    expect(out).toEqual(tools);
    expect(out).not.toBe(tools);
  });

  it("filters by id allowlist", () => {
    const out = applyToolFilter(tools, { ids: ["Bash"] });
    expect(out.map((t) => t.id)).toEqual(["Bash"]);
  });

  it("filters by server allowlist", () => {
    const out = applyToolFilter(tools, { servers: ["mempalace-tools"] });
    expect(out.map((t) => t.id)).toEqual([
      "mcp__mempalace-tools__mempalace_search",
    ]);
  });

  it("requires every required tag", () => {
    const out = applyToolFilter(tools, {
      requiredTags: ["messaging", "delivery"],
    });
    expect(out.map((t) => t.name).sort()).toEqual(["end_turn", "react"]);
  });

  it("excludes forbidden tags", () => {
    const out = applyToolFilter(tools, { forbiddenTags: ["messaging"] });
    expect(out.map((t) => t.name).sort()).toEqual(["Bash", "mempalace_search"]);
  });

  it("readOnlyOnly drops non-readonly tools", () => {
    const out = applyToolFilter(tools, { readOnlyOnly: true });
    expect(out.map((t) => t.name)).toEqual(["mempalace_search"]);
  });

  it("excludeDelivery drops delivery tools", () => {
    const out = applyToolFilter(tools, { excludeDelivery: true });
    expect(out.map((t) => t.name).sort()).toEqual(["Bash", "mempalace_search"]);
  });

  it("excludeAmbientChatTools drops ambient-chat tools", () => {
    const out = applyToolFilter(tools, { excludeAmbientChatTools: true });
    expect(out.map((t) => t.name).sort()).toEqual(["Bash", "mempalace_search"]);
  });

  it("dream default policy filter excludes delivery + ambient-chat tools", () => {
    const dreamPolicy = defaultRunPolicyFor("dream");
    const out = applyToolFilter(tools, dreamPolicy.tools.filter);
    expect(out.map((t) => t.name).sort()).toEqual(["Bash", "mempalace_search"]);
  });
});

// ── capabilities ────────────────────────────────────────────────────────────

describe("agent-runtime/capabilities", () => {
  it("deriveCapabilities reflects populated slots", () => {
    const caps = deriveCapabilities({
      chat: { runChatTurn: async function* () {} },
      models: undefined,
      sessions: undefined,
      tools: undefined,
      usage: undefined,
      background: { runBackgroundTask: async function* () {} },
    });
    expect(caps).toEqual({
      chat: true,
      background: true,
      models: false,
      sessions: false,
      tools: false,
      usage: false,
    });
  });

  it("deriveCapabilities returns all-false on empty input", () => {
    const caps = deriveCapabilities({});
    expect(caps).toEqual({
      chat: false,
      background: false,
      models: false,
      sessions: false,
      tools: false,
      usage: false,
    });
  });
});
