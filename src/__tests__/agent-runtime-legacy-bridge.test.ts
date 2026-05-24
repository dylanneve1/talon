/**
 * Phase 3 prep tests — `AgentEvent` → legacy callbacks bridge.
 *
 * Pins the contract Phase 3.x native-event backends will depend
 * on when they pipe their event stream through to the dispatcher's
 * existing callback shape:
 *
 *   - text_delta accumulates and reports per-event
 *   - reasoning accumulates on a separate "thinking" channel
 *   - assistant_message fires onTextBlock then folds into the
 *     text accumulator (so subsequent deltas keep growing)
 *   - tool_call fires onToolUse with the input object
 *   - completed returns the AgentResult from the terminator
 *   - error throws BridgedAgentError carrying the AgentError
 *   - tool_result / usage / model_swapped / warning are observed
 *     silently (no legacy callback equivalent)
 *
 * Also tests `reduceEventsToResult` — the QueryResult-shape
 * fallback that backends use during the migration window.
 */

import { describe, it, expect, vi } from "vitest";
import {
  BridgedAgentError,
  pipeEventsToCallbacks,
  reduceEventsToResult,
  type LegacyCallbacks,
} from "../core/agent-runtime/legacy-bridge.js";
import type { AgentEvent } from "../core/agent-runtime/events.js";

function streamOf(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

// ── pipeEventsToCallbacks ──────────────────────────────────────────────────

describe("pipeEventsToCallbacks / streaming", () => {
  it("accumulates text_delta and reports per-event", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const cb: LegacyCallbacks = {
      onStreamDelta: (acc, phase) => calls.push([acc, phase]),
    };
    await pipeEventsToCallbacks(
      streamOf([
        { type: "run_started" },
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: ", " },
        { type: "text_delta", text: "world!" },
        {
          type: "completed",
          result: { text: "Hello, world!", durationMs: 1, usage: emptyUsage() },
        },
      ]),
      cb,
    );
    expect(calls).toEqual([
      ["Hello", "text"],
      ["Hello, ", "text"],
      ["Hello, world!", "text"],
    ]);
  });

  it("accumulates reasoning on a separate 'thinking' channel", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const cb: LegacyCallbacks = {
      onStreamDelta: (acc, phase) => calls.push([acc, phase]),
    };
    await pipeEventsToCallbacks(
      streamOf([
        { type: "reasoning", text: "Let me think..." },
        { type: "reasoning", text: " hmm" },
        { type: "text_delta", text: "Answer." },
        {
          type: "completed",
          result: { text: "Answer.", durationMs: 1, usage: emptyUsage() },
        },
      ]),
      cb,
    );
    expect(calls).toEqual([
      ["Let me think...", "thinking"],
      ["Let me think... hmm", "thinking"],
      ["Answer.", "text"],
    ]);
  });

  it("assistant_message fires onTextBlock then folds into the text accumulator", async () => {
    const blocks: string[] = [];
    const deltas: Array<[string, string | undefined]> = [];
    const cb: LegacyCallbacks = {
      onStreamDelta: (acc, phase) => deltas.push([acc, phase]),
      onTextBlock: async (t) => {
        blocks.push(t);
      },
    };
    await pipeEventsToCallbacks(
      streamOf([
        { type: "assistant_message", text: "first " },
        { type: "text_delta", text: "second" },
        {
          type: "completed",
          result: {
            text: "first second",
            durationMs: 1,
            usage: emptyUsage(),
          },
        },
      ]),
      cb,
    );
    expect(blocks).toEqual(["first "]);
    expect(deltas).toEqual([["first second", "text"]]);
  });

  it("awaits each onTextBlock before processing the next event", async () => {
    const order: string[] = [];
    const cb: LegacyCallbacks = {
      onTextBlock: async (t) => {
        order.push(`block:${t}:start`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`block:${t}:end`);
      },
    };
    await pipeEventsToCallbacks(
      streamOf([
        { type: "assistant_message", text: "a" },
        { type: "assistant_message", text: "b" },
        {
          type: "completed",
          result: { text: "ab", durationMs: 1, usage: emptyUsage() },
        },
      ]),
      cb,
    );
    expect(order).toEqual([
      "block:a:start",
      "block:a:end",
      "block:b:start",
      "block:b:end",
    ]);
  });

  it("tool_call fires onToolUse with the input record", async () => {
    const toolCalls: Array<[string, Record<string, unknown>]> = [];
    const cb: LegacyCallbacks = {
      onToolUse: (name, input) => toolCalls.push([name, input]),
    };
    await pipeEventsToCallbacks(
      streamOf([
        {
          type: "tool_call",
          id: "1",
          name: "send",
          input: { text: "hi" },
        },
        {
          type: "completed",
          result: { text: "", durationMs: 1, usage: emptyUsage() },
        },
      ]),
      cb,
    );
    expect(toolCalls).toEqual([["send", { text: "hi" }]]);
  });

  it("tool_call defaults to {} when input is not a plain object", async () => {
    const toolCalls: Array<[string, Record<string, unknown>]> = [];
    const cb: LegacyCallbacks = {
      onToolUse: (name, input) => toolCalls.push([name, input]),
    };
    await pipeEventsToCallbacks(
      streamOf([
        { type: "tool_call", id: "1", name: "weird", input: "not-an-object" },
        { type: "tool_call", id: "2", name: "weirder", input: [1, 2, 3] },
        { type: "tool_call", id: "3", name: "nullish", input: null },
        {
          type: "completed",
          result: { text: "", durationMs: 1, usage: emptyUsage() },
        },
      ]),
      cb,
    );
    expect(toolCalls).toEqual([
      ["weird", {}],
      ["weirder", {}],
      ["nullish", {}],
    ]);
  });
});

// ── pipeEventsToCallbacks / terminators ────────────────────────────────────

describe("pipeEventsToCallbacks / terminators", () => {
  it("returns the AgentResult from a completed terminator", async () => {
    const result = await pipeEventsToCallbacks(
      streamOf([
        { type: "text_delta", text: "x" },
        {
          type: "completed",
          result: {
            text: "x",
            durationMs: 42,
            usage: {
              inputTokens: 1,
              outputTokens: 2,
              cacheRead: 0,
              cacheWrite: 0,
            },
          },
        },
      ]),
      {},
    );
    expect(result).toEqual({
      text: "x",
      durationMs: 42,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
  });

  it("throws BridgedAgentError on an error terminator", async () => {
    await expect(
      pipeEventsToCallbacks(
        streamOf([
          { type: "run_started" },
          {
            type: "error",
            error: {
              kind: "rate_limit",
              message: "slow down",
              retryable: true,
            },
          },
        ]),
        {},
      ),
    ).rejects.toThrow(BridgedAgentError);
  });

  it("BridgedAgentError preserves kind + retryable from the upstream error", async () => {
    let caught: unknown;
    try {
      await pipeEventsToCallbacks(
        streamOf([
          {
            type: "error",
            error: {
              kind: "context_overflow",
              message: "too long",
              retryable: false,
              raw: "stack here",
            },
          },
        ]),
        {},
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BridgedAgentError);
    if (!(caught instanceof BridgedAgentError)) throw new Error("unreachable");
    expect(caught.kind).toBe("context_overflow");
    expect(caught.retryable).toBe(false);
    expect(caught.raw).toBe("stack here");
    expect(caught.message).toBe("too long");
  });

  it("returns undefined when stream ends without a terminator", async () => {
    const result = await pipeEventsToCallbacks(
      streamOf([{ type: "run_started" }, { type: "text_delta", text: "hi" }]),
      {},
    );
    expect(result).toBeUndefined();
  });
});

// ── pipeEventsToCallbacks / observed-but-not-bridged events ────────────────

describe("pipeEventsToCallbacks / silent events", () => {
  it("ignores tool_result / usage / model_swapped / warning", async () => {
    const cb: LegacyCallbacks = {
      onStreamDelta: vi.fn(),
      onTextBlock: vi.fn(),
      onToolUse: vi.fn(),
    };
    await pipeEventsToCallbacks(
      streamOf([
        { type: "run_started" },
        { type: "usage", usage: emptyUsage() },
        {
          type: "tool_result",
          id: "x",
          name: "send",
          result: { ok: true },
        },
        {
          type: "model_swapped",
          from: "a",
          to: "b",
          reason: "overload",
        },
        { type: "warning", message: "deprecated tool" },
        {
          type: "completed",
          result: { text: "", durationMs: 1, usage: emptyUsage() },
        },
      ]),
      cb,
    );
    expect(cb.onStreamDelta).not.toHaveBeenCalled();
    expect(cb.onTextBlock).not.toHaveBeenCalled();
    expect(cb.onToolUse).not.toHaveBeenCalled();
  });

  it("missing callbacks are no-ops, not exceptions", async () => {
    // Empty callback bundle — every event still processes cleanly.
    await expect(
      pipeEventsToCallbacks(
        streamOf([
          { type: "text_delta", text: "x" },
          { type: "tool_call", id: "1", name: "send", input: {} },
          { type: "assistant_message", text: "block" },
          {
            type: "completed",
            result: { text: "xblock", durationMs: 1, usage: emptyUsage() },
          },
        ]),
        {},
      ),
    ).resolves.toEqual({
      text: "xblock",
      durationMs: 1,
      usage: emptyUsage(),
    });
  });
});

// ── reduceEventsToResult ───────────────────────────────────────────────────

describe("reduceEventsToResult", () => {
  it("returns the result from a completed terminator verbatim", async () => {
    const out = await reduceEventsToResult(
      streamOf([
        { type: "text_delta", text: "ignored" },
        {
          type: "completed",
          result: {
            text: "final",
            durationMs: 42,
            usage: emptyUsage(),
            modelId: "gpt-5.5",
          },
        },
      ]),
    );
    expect(out).toEqual({
      text: "final",
      durationMs: 42,
      usage: emptyUsage(),
      modelId: "gpt-5.5",
    });
  });

  it("synthesises from deltas when stream ends without a completed terminator", async () => {
    const out = await reduceEventsToResult(
      streamOf([
        { type: "text_delta", text: "Hello" },
        { type: "text_delta", text: ", world" },
        {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheRead: 0,
            cacheWrite: 0,
            modelId: "claude-opus-4-7",
          },
        },
      ]),
    );
    expect(out.text).toBe("Hello, world");
    expect(out.usage.inputTokens).toBe(10);
    expect(out.usage.outputTokens).toBe(5);
    expect(out.modelId).toBe("claude-opus-4-7");
  });

  it("throws BridgedAgentError on an error terminator", async () => {
    await expect(
      reduceEventsToResult(
        streamOf([
          {
            type: "error",
            error: {
              kind: "auth",
              message: "401",
              retryable: false,
            },
          },
        ]),
      ),
    ).rejects.toThrow(BridgedAgentError);
  });

  it("folds assistant_message into the synthesised text on the no-terminator path", async () => {
    const out = await reduceEventsToResult(
      streamOf([
        { type: "assistant_message", text: "block-a " },
        { type: "text_delta", text: "delta-b" },
      ]),
    );
    expect(out.text).toBe("block-a delta-b");
  });
});
