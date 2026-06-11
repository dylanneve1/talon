/**
 * Tests for delivery-tool argument streaming in the Claude SDK backend.
 *
 * Talon's delivery contract makes assistant prose private scratchpad —
 * the user-visible reply is the `text` argument of `end_turn` / `send`.
 * `processStreamDelta` therefore streams ONLY that argument (extracted
 * incrementally from `input_json_delta` chunks) as `text`-phase emits,
 * while prose text deltas are accumulated but never emitted.
 */

import { describe, it, expect } from "vitest";
import {
  createStreamState,
  processStreamDelta,
  extractStreamedTextArg,
  type StreamState,
} from "../backend/claude-sdk/stream.js";
import type { SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

function streamMsg(
  event: Record<string, unknown>,
  parentToolUseId: string | null = null,
): SDKPartialAssistantMessage {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: parentToolUseId,
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "test-session",
  } as unknown as SDKPartialAssistantMessage;
}

function toolStart(name: string): SDKPartialAssistantMessage {
  return streamMsg({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tu_1", name, input: {} },
  });
}

function jsonDelta(partial: string): SDKPartialAssistantMessage {
  return streamMsg({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: partial },
  });
}

function blockStop(): SDKPartialAssistantMessage {
  return streamMsg({ type: "content_block_stop", index: 0 });
}

/** Re-open the throttle window so the next delta can emit immediately. */
function openThrottle(state: StreamState): void {
  state.lastStreamUpdate = 0;
}

describe("extractStreamedTextArg", () => {
  it("returns empty string before the text key appears", () => {
    expect(extractStreamedTextArg('{"repl')).toBe("");
    expect(extractStreamedTextArg("")).toBe("");
  });

  it("extracts a growing partial value", () => {
    expect(extractStreamedTextArg('{"text": "Hel')).toBe("Hel");
    expect(extractStreamedTextArg('{"text": "Hello, wor')).toBe("Hello, wor");
    expect(extractStreamedTextArg('{"text": "Hello, world"}')).toBe(
      "Hello, world",
    );
  });

  it("decodes standard escapes and unicode", () => {
    expect(extractStreamedTextArg('{"text":"line1\\nline2\\t\\"q\\""}')).toBe(
      'line1\nline2\t"q"',
    );
    expect(extractStreamedTextArg('{"text":"caf\\u00e9"}')).toBe("café");
  });

  it("waits on incomplete trailing escapes instead of corrupting output", () => {
    // Dangling backslash — emit only what's certain.
    expect(extractStreamedTextArg('{"text":"abc\\')).toBe("abc");
    // Incomplete \uXXXX.
    expect(extractStreamedTextArg('{"text":"abc\\u00')).toBe("abc");
  });

  it('does not confuse a "text" VALUE with the "text" key', () => {
    // send(type="text") puts the literal string "text" before the key.
    expect(extractStreamedTextArg('{"type":"text","text":"hi the')).toBe(
      "hi the",
    );
  });
});

describe("processStreamDelta — delivery-tool streaming", () => {
  it("streams the end_turn text argument as text-phase emits", () => {
    const state = createStreamState();
    expect(
      processStreamDelta(toolStart("mcp__telegram-tools__end_turn"), state),
    ).toBeNull();

    openThrottle(state);
    const emit = processStreamDelta(jsonDelta('{"text":"Hello fro'), state);
    expect(emit).toEqual({ phase: "text", text: "Hello fro" });

    openThrottle(state);
    const emit2 = processStreamDelta(jsonDelta("m the stream"), state);
    expect(emit2).toEqual({ phase: "text", text: "m the stream" });
  });

  it("flushes the remainder on content_block_stop regardless of throttle", () => {
    const state = createStreamState();
    processStreamDelta(toolStart("end_turn"), state);

    openThrottle(state);
    expect(processStreamDelta(jsonDelta('{"text":"part one '), state)).toEqual({
      phase: "text",
      text: "part one ",
    });
    // Throttle window now closed — this chunk buffers.
    expect(processStreamDelta(jsonDelta('and part two"}'), state)).toBeNull();
    // Stop flushes what's left.
    expect(processStreamDelta(blockStop(), state)).toEqual({
      phase: "text",
      text: "and part two",
    });
  });

  it("separates consecutive delivery blocks with a blank line", () => {
    const state = createStreamState();
    processStreamDelta(toolStart("send"), state);
    openThrottle(state);
    expect(
      processStreamDelta(
        jsonDelta('{"type":"text","text":"first msg"}'),
        state,
      ),
    ).toEqual({ phase: "text", text: "first msg" });
    processStreamDelta(blockStop(), state);

    processStreamDelta(toolStart("end_turn"), state);
    openThrottle(state);
    expect(
      processStreamDelta(jsonDelta('{"text":"second msg"}'), state),
    ).toEqual({ phase: "text", text: "\n\nsecond msg" });
  });

  it("does not stream non-delivery tool arguments", () => {
    const state = createStreamState();
    processStreamDelta(toolStart("Read"), state);
    openThrottle(state);
    expect(
      processStreamDelta(jsonDelta('{"text":"not a reply"}'), state),
    ).toBeNull();
    expect(processStreamDelta(blockStop(), state)).toBeNull();
  });

  it("never emits prose text deltas (scratchpad stays private)", () => {
    const state = createStreamState();
    processStreamDelta(
      streamMsg({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      state,
    );
    openThrottle(state);
    const emit = processStreamDelta(
      streamMsg({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "private working notes" },
      }),
      state,
    );
    expect(emit).toBeNull();
    // Still accumulated for the result-message fallback.
    expect(state.currentBlockText).toBe("private working notes");
  });

  it("ignores subagent stream events (parent_tool_use_id set)", () => {
    const state = createStreamState();
    processStreamDelta(toolStart("end_turn"), state);
    openThrottle(state);
    const emit = processStreamDelta(
      streamMsg(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"text":"sub"}' },
        },
        "parent-tool-use-id",
      ),
      state,
    );
    expect(emit).toBeNull();
  });

  it("still emits throttled thinking deltas as reasoning", () => {
    const state = createStreamState();
    processStreamDelta(
      streamMsg({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
      state,
    );
    openThrottle(state);
    const emit = processStreamDelta(
      streamMsg({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "hmm" },
      }),
      state,
    );
    expect(emit).toEqual({ phase: "thinking", text: "hmm" });
  });
});
