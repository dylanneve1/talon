/**
 * `toEventStream` — Phase 3.x shared helper.
 *
 * Pins the queued-event ↔ awaited-query interleaving the shared
 * helper does for every backend that opts into native AgentEvent
 * emission. Backends call `toEventStream(handleMessage, params)`
 * from their factory; the assertions here cover the wire format
 * those callers depend on.
 */

import { describe, expect, it } from "vitest";
import { toEventStream } from "../backend/shared/to-event-stream.js";
import type { QueryParams, QueryResult } from "../core/types.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";

function baseParams() {
  return {
    chatId: "chat-1",
    model: "stub-model",
    text: "ping",
    senderName: "Dylan",
  };
}

async function drain(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe("toEventStream — minimum-fidelity envelope", () => {
  it("emits run_started → usage → completed for a query that produces no streaming output", async () => {
    const events = await drain(
      toEventStream(
        async () =>
          ({
            text: "hi",
            durationMs: 5,
            inputTokens: 1,
            outputTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
          }) satisfies QueryResult,
        baseParams(),
      ),
    );

    expect(events.map((e) => e.type)).toEqual([
      "run_started",
      "usage",
      "completed",
    ]);
    const completed = events.find((e) => e.type === "completed");
    if (completed?.type !== "completed") throw new Error("not completed");
    expect(completed.result?.text).toBe("hi");
    expect(completed.result?.usage.inputTokens).toBe(1);
  });

  it("relays onStreamDelta → text_delta during the query", async () => {
    const events = await drain(
      toEventStream(async (legacy: QueryParams) => {
        legacy.onStreamDelta?.("partial");
        legacy.onStreamDelta?.("partial response");
        return {
          text: "partial response",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas).toHaveLength(2);
    if (deltas[0]?.type !== "text_delta") throw new Error("expected delta");
    expect(deltas[0].text).toBe("partial");
    if (deltas[1]?.type !== "text_delta") throw new Error("expected delta");
    expect(deltas[1].text).toBe("partial response");
  });

  it("relays onTextBlock → assistant_message", async () => {
    const events = await drain(
      toEventStream(async (legacy: QueryParams) => {
        await legacy.onTextBlock?.("first block");
        await legacy.onTextBlock?.("second block");
        return {
          text: "second block",
          durationMs: 10,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const blocks = events.filter((e) => e.type === "assistant_message");
    expect(blocks.map((e) => (e.type === "assistant_message" ? e.text : ""))).toEqual([
      "first block",
      "second block",
    ]);
  });

  it("relays onToolUse → tool_call with stable id + name + input", async () => {
    const events = await drain(
      toEventStream(async (legacy: QueryParams) => {
        legacy.onToolUse?.("send_message", { text: "hi" });
        legacy.onToolUse?.("end_turn", {});
        return {
          text: "",
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const tools = events.filter((e) => e.type === "tool_call");
    expect(tools.map((t) => (t.type === "tool_call" ? t.name : ""))).toEqual([
      "send_message",
      "end_turn",
    ]);
    if (tools[0]?.type !== "tool_call") throw new Error("expected tool_call");
    expect(tools[0].input).toEqual({ text: "hi" });
    expect(tools[0].id).toMatch(/^send_message-\d+-[a-z0-9]+$/);
  });

  it("classifies a rejected query as an error event and terminates", async () => {
    const events = await drain(
      toEventStream(async () => {
        throw new Error("context length exceeded");
      }, baseParams()),
    );

    expect(events[0]?.type).toBe("run_started");
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected error terminator");
    expect(last.error.kind).toBe("context_overflow");
    expect(last.error.message).toContain("context length");
  });

  it("preserves event ordering: delta → tool → completed", async () => {
    const events = await drain(
      toEventStream(async (legacy: QueryParams) => {
        legacy.onStreamDelta?.("thinking…");
        legacy.onToolUse?.("read_file", { path: "x" });
        legacy.onStreamDelta?.("done");
        return {
          text: "done",
          durationMs: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, baseParams()),
    );

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "run_started",
      "text_delta",
      "tool_call",
      "text_delta",
      "usage",
      "completed",
    ]);
  });

  it("does not relay caller-supplied callbacks — toEventStream owns the streaming surface", async () => {
    // RunChatTurnEventsParams is `Omit<QueryParams, "onStreamDelta" |
    // "onTextBlock" | "onToolUse">`. Even if a caller smuggled extra
    // callback fields via a cast, the helper's queued callbacks
    // override them. This pins that contract.
    let extraCallbackFired = false;
    // Deliberately stuff a callback that should never be exercised —
    // the wrapper builds its own and overwrites any caller-supplied
    // streaming hooks on the legacy params it constructs.
    const params = {
      ...baseParams(),
      onStreamDelta: () => {
        extraCallbackFired = true;
      },
    } as Parameters<typeof toEventStream>[1];
    await drain(
      toEventStream(async (legacy: QueryParams) => {
        legacy.onStreamDelta?.("ignored");
        return {
          text: "ok",
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }, params),
    );
    expect(extraCallbackFired).toBe(false);
  });
});
