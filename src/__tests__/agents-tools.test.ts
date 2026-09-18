/**
 * The sub-agent tool family and the actions behind it.
 *
 * Three things are worth pinning: every tool routes to the action of the same
 * name (the model's vocabulary and the gateway's must not drift), the
 * agent-side tools refuse a chat caller, and the chat-side ones only see their
 * own chat's agents.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { agentTools } from "../core/tools/ops/agents.js";
import {
  agentContextActions,
  agentHandlers,
} from "../core/engine/gateway-actions/agents/index.js";
import {
  handleAgentContextAction,
  isAgentContextAction,
} from "../core/engine/gateway-actions/index.js";
import {
  agentContextLabel,
  agentRegistry,
  initAgentDelivery,
  type AgentParent,
  type AgentRecord,
} from "../core/agents/index.js";
import type {
  ActionResult,
  ExecuteParams,
  ExecuteResult,
} from "../core/types.js";

const CHAT: AgentParent = { kind: "chat", chatId: "d_77", numericChatId: 77 };

const execute = vi.fn(
  async (_params: ExecuteParams): Promise<ExecuteResult> => ({
    text: "",
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    bridgeMessageCount: 0,
  }),
);

function live(parent: AgentParent, label = "probe"): AgentRecord {
  const outcome = agentRegistry.register(
    {
      label,
      brief: "a brief nobody else should see",
      parent,
      backendId: "claude",
    },
    { maxConcurrent: 10, maxDepth: 3, defaultTimeoutMs: 1000 },
  );
  if (!outcome.ok) throw new Error(outcome.error);
  agentRegistry.start(outcome.record.id, {
    model: "sonnet",
    abort: new AbortController(),
  });
  return agentRegistry.get(outcome.record.id) as AgentRecord;
}

/** Call an action as a chat would. */
function asChat(
  action: string,
  body: Record<string, unknown> = {},
): Promise<ActionResult> | ActionResult {
  const handler = agentHandlers[action];
  if (!handler) throw new Error(`no handler for ${action}`);
  return handler({ action, ...body }, 77, undefined, "d_77");
}

/** Call an action as a running sub-agent would (via the gateway's route). */
async function asAgent(
  agentId: string,
  action: string,
  body: Record<string, unknown> = {},
): Promise<ActionResult> {
  const result = await handleAgentContextAction(
    { action, ...body },
    agentContextLabel(agentId),
  );
  if (!result) throw new Error(`action ${action} was not routed`);
  return result;
}

beforeEach(() => {
  agentRegistry.resetForTest();
  execute.mockClear();
  initAgentDelivery({ execute });
});

afterEach(() => {
  agentRegistry.resetForTest();
});

describe("tool → action routing", () => {
  it("routes every tool to the bridge action of the same name", async () => {
    for (const tool of agentTools) {
      const seen: string[] = [];
      await tool.execute({ probe: 1 }, async (action) => {
        seen.push(action);
        return { ok: true };
      });
      expect(seen).toEqual([tool.name]);
    }
  });

  it("has a gateway handler for every tool, and no orphan handlers", () => {
    const toolNames = agentTools.map((tool) => tool.name).sort();
    expect(Object.keys(agentHandlers).sort()).toEqual(toolNames);
    expect([...agentContextActions].sort()).toEqual(toolNames);
    for (const name of toolNames) expect(isAgentContextAction(name)).toBe(true);
    expect(isAgentContextAction("send")).toBe(false);
  });

  it("tags the whole family `agents`", () => {
    expect(agentTools.every((tool) => tool.tag === "agents")).toBe(true);
  });
});

describe("agent-side actions", () => {
  it("refuse a chat caller rather than silently no-oping", async () => {
    for (const action of ["report_result", "message_parent", "check_inbox"]) {
      const result = await asChat(action, { summary: "x", text: "x" });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("only callable inside a sub-agent run");
    }
  });

  it("refuse an agent id that is no longer live", async () => {
    const record = live(CHAT);
    agentRegistry.settle(record.id, { state: "done" });
    const result = await asAgent(record.id, "report_result", { summary: "x" });
    expect(result.ok).toBe(false);
  });

  it("record a result once and refuse a second report", async () => {
    const record = live(CHAT);
    const first = await asAgent(record.id, "report_result", {
      summary: "found it",
      details: "here",
    });
    expect(first.ok).toBe(true);
    expect(agentRegistry.get(record.id)?.result).toEqual({
      summary: "found it",
      details: "here",
    });
    const second = await asAgent(record.id, "report_result", { summary: "no" });
    expect(second.ok).toBe(false);
    expect(second.error).toContain("already reported");
  });

  it("drain the inbox exactly once", async () => {
    const record = live(CHAT);
    await asChat("send_to_agent", { agent_id: record.id, text: "look at #12" });
    const drained = await asAgent(record.id, "check_inbox");
    expect(drained.text).toContain("look at #12");
    const empty = await asAgent(record.id, "check_inbox");
    expect(empty.text).toContain("Inbox empty");
  });

  it("message_parent returns immediately and wakes the parent chat", async () => {
    const record = live(CHAT);
    const result = await asAgent(record.id, "message_parent", {
      text: "still working",
    });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
  });
});

describe("chat-side actions", () => {
  it("lists this chat's agents and its descendants, never another chat's", async () => {
    const mine = live(CHAT, "mine");
    live({ kind: "agent", agentId: mine.id }, "my-child");
    live({ kind: "chat", chatId: "d_99", numericChatId: 99 }, "theirs");

    const result = await asChat("list_agents");
    expect(result.text).toContain("mine");
    expect(result.text).toContain("my-child");
    expect(result.text).not.toContain("theirs");
  });

  it("never leaks the brief through status", async () => {
    const record = live(CHAT);
    const result = await asChat("agent_status", { agent_id: record.id });
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("a brief nobody else should see");
    expect(result.text).toContain(record.id);
  });

  it("refuses an agent id belonging to another chat", async () => {
    const other = live({ kind: "chat", chatId: "d_99", numericChatId: 99 });
    const result = await asChat("agent_status", { agent_id: other.id });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No agent");
  });

  it("send_to_agent refuses a settled agent", async () => {
    const record = live(CHAT);
    agentRegistry.settle(record.id, { state: "done" });
    const result = await asChat("send_to_agent", {
      agent_id: record.id,
      text: "hi",
    });
    expect(result.ok).toBe(false);
  });

  it("kill_agent aborts a running agent and reports an already-settled one", async () => {
    const record = live(CHAT);
    const killed = await asChat("kill_agent", { agent_id: record.id });
    expect(killed.ok).toBe(true);
    expect(agentRegistry.killRequested(record.id)).toBe(true);

    agentRegistry.settle(record.id, { state: "killed" });
    const again = await asChat("kill_agent", { agent_id: record.id });
    expect(again.text).toContain("already settled");
  });

  it("wait_for_agent resolves on settlement", async () => {
    const record = live(CHAT);
    const waiting = asChat("wait_for_agent", {
      agent_id: record.id,
      timeout_s: 30,
    });
    agentRegistry.report(record.id, { summary: "all clear" });
    agentRegistry.settle(record.id, { state: "done" });
    const result = await waiting;
    expect(result.ok).toBe(true);
    expect(result.text).toContain("all clear");
    expect(result.text).toContain("State: done");
  });

  it("wait_for_agent returns the live state on timeout", async () => {
    const record = live(CHAT);
    const result = await asChat("wait_for_agent", {
      agent_id: record.id,
      timeout_s: 0,
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("still running");
  });

  it("spawn_agent validates its body before touching a backend", async () => {
    expect((await asChat("spawn_agent", { label: "x" })).error).toBe(
      "Missing brief",
    );
    expect((await asChat("spawn_agent", { brief: "x" })).error).toBe(
      "Missing label",
    );
    const badEffort = await asChat("spawn_agent", {
      brief: "x",
      label: "y",
      effort: "turbo",
    });
    expect(badEffort.error).toContain("Unknown effort");
  });
});
