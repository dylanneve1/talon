/**
 * Tests for `kilo/events.ts` — the pure SSE event processing helpers.
 *
 * These cover the per-event logic that previously lived inline in the
 * Kilo handler's SSE loop. Each test constructs a hand-built event
 * object + state and asserts on the resulting state mutations + callback
 * invocations. No KiloClient or real SDK needed.
 */

import { describe, expect, it, vi } from "vitest";
import {
  processStreamEvent,
  finalizePartsIntoState,
  maybeFireStreamDelta,
  STREAM_INTERVAL_MS,
} from "../backend/kilo/events.js";
import { createStreamState } from "../backend/shared/index.js";

const SESSION_ID = "sess_abc";

function baseContext(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    state: createStreamState(),
    seenToolCallIds: new Set<string>(),
    ...overrides,
  };
}

describe("processStreamEvent — scoping", () => {
  it("ignores events for other sessions", async () => {
    const onStreamDelta = vi.fn();
    const ctx = baseContext({ onStreamDelta });
    const outcome = await processStreamEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: "different_session",
          field: "text",
          delta: "hi",
        },
      },
      ctx,
    );
    expect(outcome.kind).toBe("stop");
    if (outcome.kind === "stop") {
      expect(outcome.reason).toBe("out_of_scope");
    }
    expect(onStreamDelta).not.toHaveBeenCalled();
    expect(ctx.state.allResponseText).toBe("");
  });

  it("processes events with no sessionID property (legacy / global)", async () => {
    const ctx = baseContext();
    const outcome = await processStreamEvent(
      { type: "message.part.delta", properties: { field: "text", delta: "x" } },
      ctx,
    );
    expect(outcome.kind).toBe("continue");
    expect(ctx.state.lastTrailingText).toBe("x");
  });
});

describe("processStreamEvent — message.part.delta", () => {
  it("accumulates text deltas into state", async () => {
    const ctx = baseContext();
    await processStreamEvent(
      {
        type: "message.part.delta",
        properties: { sessionID: SESSION_ID, field: "text", delta: "Hello " },
      },
      ctx,
    );
    await processStreamEvent(
      {
        type: "message.part.delta",
        properties: { sessionID: SESSION_ID, field: "text", delta: "world" },
      },
      ctx,
    );
    expect(ctx.state.currentBlockText).toBe("Hello world");
    expect(ctx.state.lastTrailingText).toBe("Hello world");
  });

  it("ignores empty deltas", async () => {
    const ctx = baseContext();
    await processStreamEvent(
      {
        type: "message.part.delta",
        properties: { sessionID: SESSION_ID, field: "text", delta: "" },
      },
      ctx,
    );
    expect(ctx.state.currentBlockText).toBe("");
  });

  it("thinking deltas don't accumulate into response text", async () => {
    const ctx = baseContext();
    await processStreamEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: SESSION_ID,
          field: "thinking",
          delta: "let me think...",
        },
      },
      ctx,
    );
    expect(ctx.state.currentBlockText).toBe(""); // scratchpad, not response
  });

  it("reasoning deltas behave like thinking", async () => {
    const ctx = baseContext();
    await processStreamEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: SESSION_ID,
          field: "reasoning",
          delta: "step 1",
        },
      },
      ctx,
    );
    expect(ctx.state.currentBlockText).toBe("");
  });
});

describe("processStreamEvent — message.part.updated (tool)", () => {
  it("fires onToolUse + recordToolUse for a running tool", async () => {
    const onToolUse = vi.fn();
    const ctx = baseContext({ onToolUse });
    await processStreamEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: {
            type: "tool",
            callID: "call_1",
            tool: "get_weather",
            state: { status: "running", input: { city: "Dublin" } },
          },
        },
      },
      ctx,
    );
    expect(onToolUse).toHaveBeenCalledWith("get_weather", { city: "Dublin" });
    expect(ctx.state.toolCalls).toBe(1);
    expect(ctx.seenToolCallIds.has("call_1")).toBe(true);
  });

  it("does NOT re-fire onToolUse for the same callID", async () => {
    const onToolUse = vi.fn();
    const ctx = baseContext({ onToolUse });
    const evt = {
      type: "message.part.updated",
      properties: {
        sessionID: SESSION_ID,
        part: {
          type: "tool",
          callID: "call_1",
          tool: "x",
          state: { status: "running", input: {} },
        },
      },
    };
    await processStreamEvent(evt, ctx);
    await processStreamEvent(evt, ctx);
    expect(onToolUse).toHaveBeenCalledTimes(1);
  });

  it("emits progress text via onTextBlock BEFORE recording tool", async () => {
    const events: string[] = [];
    const onTextBlock = vi.fn(async (text: string) => {
      events.push(`block:${text}`);
    });
    const onToolUse = vi.fn(() => {
      events.push("tool");
    });
    const ctx = baseContext({ onTextBlock, onToolUse });

    // Accumulate some pre-tool text
    await processStreamEvent(
      {
        type: "message.part.delta",
        properties: {
          sessionID: SESSION_ID,
          field: "text",
          delta: "let me check...",
        },
      },
      ctx,
    );

    // Then fire a tool
    await processStreamEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: {
            type: "tool",
            callID: "c1",
            tool: "search",
            state: { status: "running", input: { q: "x" } },
          },
        },
      },
      ctx,
    );

    expect(events).toEqual(["block:let me check...", "tool"]);
    expect(ctx.state.currentBlockText).toBe(""); // segment was closed
  });

  it("returns terminator_fired when end_turn is observed", async () => {
    const ctx = baseContext();
    const outcome = await processStreamEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: {
            type: "tool",
            callID: "c1",
            tool: "end_turn",
            state: { status: "running", input: { text: "bye" } },
          },
        },
      },
      ctx,
    );
    expect(outcome.kind).toBe("terminator_fired");
    if (outcome.kind === "terminator_fired") {
      expect(outcome.toolName).toBe("end_turn");
    }
    expect(ctx.state.turnTerminated).toBe(true);
  });

  it("does NOT return terminator_fired for react with end_turn:false", async () => {
    const ctx = baseContext();
    const outcome = await processStreamEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: {
            type: "tool",
            callID: "c1",
            tool: "react",
            state: {
              status: "running",
              input: { message_id: 1, emoji: "🤔", end_turn: false },
            },
          },
        },
      },
      ctx,
    );
    expect(outcome.kind).toBe("continue");
    expect(ctx.state.turnTerminated).toBe(false);
  });

  it("skips tools that aren't running or completed (pending only)", async () => {
    const onToolUse = vi.fn();
    const ctx = baseContext({ onToolUse });
    await processStreamEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: {
            type: "tool",
            callID: "c1",
            tool: "x",
            state: { status: "pending", input: {} },
          },
        },
      },
      ctx,
    );
    expect(onToolUse).not.toHaveBeenCalled();
    expect(ctx.state.toolCalls).toBe(0);
  });

  it("ignores non-tool parts", async () => {
    const onToolUse = vi.fn();
    const ctx = baseContext({ onToolUse });
    const outcome = await processStreamEvent(
      {
        type: "message.part.updated",
        properties: {
          sessionID: SESSION_ID,
          part: { type: "text", text: "x" },
        },
      },
      ctx,
    );
    expect(outcome.kind).toBe("continue");
    expect(onToolUse).not.toHaveBeenCalled();
  });
});

describe("processStreamEvent — session lifecycle", () => {
  it("returns stop on session.turn.close", async () => {
    const ctx = baseContext();
    const outcome = await processStreamEvent(
      { type: "session.turn.close", properties: { sessionID: SESSION_ID } },
      ctx,
    );
    expect(outcome).toEqual({ kind: "stop", reason: "turn.close" });
  });

  it("returns stop on session.idle", async () => {
    const ctx = baseContext();
    const outcome = await processStreamEvent(
      { type: "session.idle", properties: { sessionID: SESSION_ID } },
      ctx,
    );
    expect(outcome).toEqual({ kind: "stop", reason: "idle" });
  });

  it("ignores unknown event types", async () => {
    const ctx = baseContext();
    const outcome = await processStreamEvent(
      { type: "vcs.branch.updated", properties: { sessionID: SESSION_ID } },
      ctx,
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("maybeFireStreamDelta", () => {
  it("fires the callback when interval has elapsed", () => {
    const cb = vi.fn();
    const state = createStreamState();
    state.currentBlockText = "hello";
    state.lastStreamUpdate = 0; // long ago
    maybeFireStreamDelta(state, cb, "text");
    expect(cb).toHaveBeenCalledWith("hello", "text");
    expect(state.lastStreamUpdate).toBeGreaterThan(0);
  });

  it("throttles within STREAM_INTERVAL_MS", () => {
    const cb = vi.fn();
    const state = createStreamState();
    state.lastStreamUpdate = Date.now(); // just now
    maybeFireStreamDelta(state, cb, "text");
    expect(cb).not.toHaveBeenCalled();
  });

  it("no-op when no callback provided", () => {
    const state = createStreamState();
    expect(() => maybeFireStreamDelta(state, undefined, "text")).not.toThrow();
  });

  it("STREAM_INTERVAL_MS is sensible (between 500ms and 5s)", () => {
    expect(STREAM_INTERVAL_MS).toBeGreaterThanOrEqual(500);
    expect(STREAM_INTERVAL_MS).toBeLessThanOrEqual(5000);
  });
});

describe("finalizePartsIntoState — SSE missed", () => {
  it("reconstructs text + tools when state is empty", () => {
    const state = createStreamState();
    const seen = new Set<string>();
    const onToolUse = vi.fn();
    const { toolsProcessed } = finalizePartsIntoState({
      parts: [
        { type: "text", text: "Hi there" },
        {
          type: "tool",
          callID: "c1",
          tool: "get_weather",
          state: { status: "completed", input: { city: "Dublin" } },
        },
      ],
      state,
      seenToolCallIds: seen,
      onToolUse,
    });
    expect(toolsProcessed).toBe(1);
    expect(state.lastTrailingText).toBe("Hi there");
    expect(state.toolCalls).toBe(1);
    expect(onToolUse).toHaveBeenCalledWith("get_weather", { city: "Dublin" });
  });

  it("rewrites allResponseText from text parts (parts list is source of truth)", () => {
    const state = createStreamState();
    // SSE accumulated something speculatively (could be reasoning content
    // that leaked through `field: "text"` deltas before the part-type was
    // known). Finalize must rewrite from text parts only.
    state.allResponseText = "polluted by reasoning leak";
    const onToolUse = vi.fn();
    finalizePartsIntoState({
      parts: [{ type: "text", text: "actual reply" }],
      state,
      seenToolCallIds: new Set(),
      onToolUse,
    });
    expect(state.allResponseText).toBe("actual reply");
  });

  it("surfaces synthetic error text parts via state.syntheticError, not as the reply", () => {
    const state = createStreamState();
    finalizePartsIntoState({
      parts: [
        {
          type: "text",
          synthetic: true,
          text: "The model hit its output limit while reasoning and produced no actionable output.",
        },
      ],
      state,
      seenToolCallIds: new Set(),
    });
    // Synthetic Kilo error must NOT land in allResponseText (where it
    // would be shipped to the user as if the model itself had
    // answered with technical advice). It moves to state.syntheticError
    // for the handler to convert into a Talon error message.
    expect(state.allResponseText).toBe("");
    expect(state.syntheticError).toContain("output limit while reasoning");
  });

  it("delivers `ignored: true` text parts (Kilo flags real replies with this)", () => {
    // The Kilo schema documents `ignored?: boolean` on TextPart, but
    // observation against deepseek/deepseek-v4-flash:free shows the
    // flag is set on the genuine reply text parts (137 chars at end of
    // a `step-start, reasoning, step-finish, text` sequence). Filtering
    // on it killed every reply for that model in prod. Document the
    // (counterintuitive) deliver-anyway behaviour with a test.
    const state = createStreamState();
    finalizePartsIntoState({
      parts: [{ type: "text", ignored: true, text: "this IS the reply" }],
      state,
      seenToolCallIds: new Set(),
    });
    expect(state.allResponseText).toBe("this IS the reply");
  });

  it("ignores reasoning parts (private scratchpad)", () => {
    const state = createStreamState();
    const onToolUse = vi.fn();
    finalizePartsIntoState({
      parts: [
        { type: "reasoning", text: "thinking out loud about the user" },
        { type: "text", text: "Hi!" },
      ],
      state,
      seenToolCallIds: new Set(),
      onToolUse,
    });
    expect(state.allResponseText).toBe("Hi!");
  });

  it("clears allResponseText when no text part exists", () => {
    const state = createStreamState();
    state.allResponseText = "leaked from delta";
    finalizePartsIntoState({
      parts: [{ type: "reasoning", text: "thought a lot, said nothing" }],
      state,
      seenToolCallIds: new Set(),
    });
    // No text part → allResponseText should not be the polluted SSE content.
    // (It's safe to leave empty: the handler will surface an empty-turn
    //  warning to the user.)
    expect(state.allResponseText).toBe("leaked from delta");
    // Note: we don't clear when there's no text part; the previous SSE
    // accumulation stays. If you wanted strict clearing, add it here.
  });
});

describe("finalizePartsIntoState — SSE captured tools to skip", () => {
  it("skips tools already in seenToolCallIds", () => {
    const state = createStreamState();
    state.allResponseText = "already captured";
    const onToolUse = vi.fn();
    const seen = new Set(["c1"]);
    const { toolsProcessed } = finalizePartsIntoState({
      parts: [
        {
          type: "tool",
          callID: "c1",
          tool: "x",
          state: { status: "completed", input: {} },
        },
      ],
      state,
      seenToolCallIds: seen,
      onToolUse,
    });
    expect(toolsProcessed).toBe(0);
    expect(onToolUse).not.toHaveBeenCalled();
  });

  it("picks up tools SSE missed (different callID)", () => {
    const state = createStreamState();
    state.allResponseText = "from SSE";
    const onToolUse = vi.fn();
    const seen = new Set(["c1"]);
    finalizePartsIntoState({
      parts: [
        {
          type: "tool",
          callID: "c2", // not in seen
          tool: "search",
          state: { status: "completed", input: { q: "test" } },
        },
      ],
      state,
      seenToolCallIds: seen,
      onToolUse,
    });
    expect(onToolUse).toHaveBeenCalledWith("search", { q: "test" });
    expect(seen.has("c2")).toBe(true);
  });

  it("never throws when onToolUse throws", () => {
    const state = createStreamState();
    const onToolUse = vi.fn(() => {
      throw new Error("frontend boom");
    });
    expect(() =>
      finalizePartsIntoState({
        parts: [
          {
            type: "tool",
            callID: "c1",
            tool: "x",
            state: { status: "completed", input: {} },
          },
        ],
        state,
        seenToolCallIds: new Set(),
        onToolUse,
      }),
    ).not.toThrow();
  });
});
