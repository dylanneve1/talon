/**
 * Phase 4 prep tests — `AgentEventLogRenderer`.
 *
 * Pins the markdown fragments each event type produces and the
 * stream-level invariants Phase 4 heartbeat / dream wiring will
 * depend on:
 *
 *   - text_delta is buffered; flushed on assistant_message / tool_call
 *     / terminator / stream-end
 *   - assistant_message produces a fenced block
 *   - reasoning produces a collapsed <details> block
 *   - tool_call header is matched to tool_result by id
 *   - usage / model_swapped / warning produce status lines
 *   - error throws LogRendererError after flushing markdown
 *   - completed returns AgentResult
 */

import { describe, it, expect } from "vitest";
import {
  freshRenderState,
  LogRendererError,
  renderEvent,
  streamLog,
} from "../core/agent-runtime/event-log-renderer.js";
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

async function collect(stream: AsyncIterable<AgentEvent>): Promise<{
  fragments: string[];
  output: string;
  result: Awaited<ReturnType<typeof streamLog>>;
  error?: LogRendererError;
}> {
  const fragments: string[] = [];
  let result: Awaited<ReturnType<typeof streamLog>>;
  let error: LogRendererError | undefined;
  try {
    result = await streamLog(stream, async (f) => {
      fragments.push(f);
    });
  } catch (err) {
    if (err instanceof LogRendererError) error = err;
    else throw err;
  }
  return { fragments, output: fragments.join(""), result, error };
}

// ── renderEvent — per-event shapes ──────────────────────────────────────────

describe("renderEvent / per-event shapes", () => {
  it("run_started emits a single header line", () => {
    const { fragment } = renderEvent(
      { type: "run_started" },
      freshRenderState(),
    );
    expect(fragment).toBe(" ▶ Run started\n");
  });

  it("text_delta is buffered, no fragment emitted", () => {
    const { fragment, state } = renderEvent(
      { type: "text_delta", text: "hello" },
      freshRenderState(),
    );
    expect(fragment).toBe("");
    expect(state.pendingTextDelta).toBe("hello");
  });

  it("assistant_message flushes buffered text then emits its own block", () => {
    const initial = freshRenderState();
    const { state: after_delta } = renderEvent(
      { type: "text_delta", text: "buffered-" },
      initial,
    );
    const { fragment, state: after_msg } = renderEvent(
      { type: "assistant_message", text: "block" },
      after_delta,
    );
    expect(fragment).toContain("buffered-");
    expect(fragment).toContain("block");
    expect(after_msg.pendingTextDelta).toBe("");
  });

  it("reasoning produces a collapsed <details> block", () => {
    const { fragment } = renderEvent(
      { type: "reasoning", text: "let me think", signature: "sig-x" },
      freshRenderState(),
    );
    expect(fragment).toContain("<details>");
    expect(fragment).toContain("Reasoning (sig-x)");
    expect(fragment).toContain("let me think");
    expect(fragment).toContain("</details>");
  });

  it("tool_call emits a header + JSON block + remembers id for matching", () => {
    const { fragment, state } = renderEvent(
      {
        type: "tool_call",
        id: "call-1",
        name: "send",
        input: { text: "hi", chat_id: 42 },
      },
      freshRenderState(),
    );
    expect(fragment).toContain("### Tool call: send");
    expect(fragment).toContain('"text": "hi"');
    expect(fragment).toContain('"chat_id": 42');
    expect(state.toolCallHeaders.get("call-1")).toBe("### Tool call: send");
  });

  it("tool_result emits a labelled fragment with the matching header in scope", () => {
    let state = freshRenderState();
    state = renderEvent(
      {
        type: "tool_call",
        id: "call-1",
        name: "send",
        input: { text: "hi" },
      },
      state,
    ).state;
    const { fragment } = renderEvent(
      {
        type: "tool_result",
        id: "call-1",
        name: "send",
        result: { ok: true, message_id: 99 },
      },
      state,
    );
    expect(fragment).toContain("**Tool result** (send)");
    expect(fragment).toContain('"message_id": 99');
  });

  it("tool_result without matching header emits a standalone fragment", () => {
    const { fragment } = renderEvent(
      {
        type: "tool_result",
        id: "orphan",
        name: "react",
        result: { ok: true },
      },
      freshRenderState(),
    );
    expect(fragment).toContain("### Tool result: react");
  });

  it("tool_result error path replaces the JSON block with an Error: line", () => {
    const { fragment } = renderEvent(
      {
        type: "tool_result",
        id: "x",
        name: "send",
        error: "bridge timeout",
      },
      freshRenderState(),
    );
    expect(fragment).toContain("Error: bridge timeout");
    expect(fragment).not.toContain("```json");
  });

  it("usage emits a one-line status with token counters + model id", () => {
    const { fragment } = renderEvent(
      {
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheRead: 20,
          cacheWrite: 5,
          modelId: "gpt-5.5",
        },
      },
      freshRenderState(),
    );
    expect(fragment).toBe(
      " ▸ Usage: in=100 out=50 cacheR=20 cacheW=5 model=gpt-5.5\n",
    );
  });

  it("model_swapped emits a one-line warning with from → to + reason", () => {
    const { fragment } = renderEvent(
      {
        type: "model_swapped",
        from: "gpt-5-codex",
        to: "gpt-5.5",
        reason: "API-key-only model on OAuth",
      },
      freshRenderState(),
    );
    expect(fragment).toBe(
      " ⚠ Model swapped: gpt-5-codex → gpt-5.5 (API-key-only model on OAuth)\n",
    );
  });

  it("warning emits a one-line message", () => {
    const { fragment } = renderEvent(
      { type: "warning", message: "deprecated tool" },
      freshRenderState(),
    );
    expect(fragment).toBe(" ⚠ deprecated tool\n");
  });

  it("error renders a section block with kind + retryable + message", () => {
    const { fragment, state } = renderEvent(
      {
        type: "error",
        error: {
          kind: "rate_limit",
          message: "slow down",
          retryable: true,
        },
      },
      freshRenderState(),
    );
    expect(fragment).toContain("### Error (rate_limit, retryable=true)");
    expect(fragment).toContain("slow down");
    expect(state.finished).toBe(true);
  });

  it("error renders raw stack inside a code block when present", () => {
    const { fragment } = renderEvent(
      {
        type: "error",
        error: {
          kind: "auth",
          message: "401",
          retryable: false,
          raw: "Error: 401\n  at handler",
        },
      },
      freshRenderState(),
    );
    expect(fragment).toContain("Error: 401");
    expect(fragment).toContain("at handler");
    expect(fragment).toContain("```\n");
  });

  it("completed emits a duration + final usage line", () => {
    const { fragment, state } = renderEvent(
      {
        type: "completed",
        result: {
          text: "done",
          durationMs: 1234,
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      },
      freshRenderState(),
    );
    expect(fragment).toContain(" ✓ Completed in 1234ms");
    expect(fragment).toContain("(final: in=1 out=2");
    expect(state.finished).toBe(true);
  });
});

// ── streamLog — end-to-end ──────────────────────────────────────────────────

describe("streamLog", () => {
  it("buffers text_delta and flushes on completed", async () => {
    const { output, result } = await collect(
      streamOf([
        { type: "run_started" },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world" },
        {
          type: "completed",
          result: { text: "Hello world", durationMs: 1, usage: emptyUsage() },
        },
      ]),
    );
    expect(output).toContain(" ▶ Run started");
    expect(output).toContain("Hello world");
    expect(output).toContain(" ✓ Completed in 1ms");
    expect(result?.text).toBe("Hello world");
  });

  it("flushes pending text before a tool_call and resumes buffering after", async () => {
    const { output } = await collect(
      streamOf([
        { type: "text_delta", text: "prelude " },
        {
          type: "tool_call",
          id: "1",
          name: "send",
          input: { text: "hi" },
        },
        { type: "text_delta", text: "epilogue" },
        {
          type: "completed",
          result: {
            text: "prelude epilogue",
            durationMs: 1,
            usage: emptyUsage(),
          },
        },
      ]),
    );
    // prelude flushed BEFORE the tool_call section
    expect(output.indexOf("prelude")).toBeLessThan(output.indexOf("Tool call"));
    // epilogue flushed in the completed phase
    expect(output.indexOf("epilogue")).toBeGreaterThan(
      output.indexOf("Tool call"),
    );
    expect(output.indexOf("Completed")).toBeGreaterThan(
      output.indexOf("epilogue"),
    );
  });

  it("throws LogRendererError on error events but flushes the error markdown first", async () => {
    const { error, fragments } = await collect(
      streamOf([
        { type: "text_delta", text: "midstream" },
        {
          type: "error",
          error: {
            kind: "context_overflow",
            message: "too long",
            retryable: false,
          },
        },
      ]),
    );
    expect(error).toBeInstanceOf(LogRendererError);
    expect(error?.agentError.kind).toBe("context_overflow");
    const joined = fragments.join("");
    // pending text flushed before the error block
    expect(joined).toContain("midstream");
    expect(joined).toContain("### Error (context_overflow");
  });

  it("returns undefined when stream ends without a terminator (defensive flush)", async () => {
    const { output, result } = await collect(
      streamOf([{ type: "text_delta", text: "orphaned text" }]),
    );
    expect(result).toBeUndefined();
    expect(output).toContain("orphaned text");
  });

  it("interleaves tool_call + tool_result blocks in order", async () => {
    const { output } = await collect(
      streamOf([
        {
          type: "tool_call",
          id: "1",
          name: "send",
          input: { text: "hi" },
        },
        {
          type: "tool_result",
          id: "1",
          name: "send",
          result: { ok: true },
        },
        {
          type: "tool_call",
          id: "2",
          name: "react",
          input: { emoji: "🎉" },
        },
        {
          type: "tool_result",
          id: "2",
          name: "react",
          result: { ok: true },
        },
        {
          type: "completed",
          result: { text: "", durationMs: 1, usage: emptyUsage() },
        },
      ]),
    );
    expect(output.indexOf("### Tool call: send")).toBeLessThan(
      output.indexOf("**Tool result** (send)"),
    );
    expect(output.indexOf("**Tool result** (send)")).toBeLessThan(
      output.indexOf("### Tool call: react"),
    );
    expect(output.indexOf("### Tool call: react")).toBeLessThan(
      output.indexOf("**Tool result** (react)"),
    );
  });
});
