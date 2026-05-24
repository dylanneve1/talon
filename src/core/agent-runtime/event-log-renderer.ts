/**
 * `AgentEventLogRenderer` — consume an `AgentEvent` stream and
 * produce structured markdown for heartbeat / dream / trigger
 * log files.
 *
 * Phase 4 of the architecture unification plan: heartbeat and
 * dream currently build their markdown logs inline by mixing
 * SDK-specific event handlers with appendLog calls (~150 LOC
 * each, slightly different per backend). This module is the
 * shared renderer — backends emit `AgentEvent`s, core writes
 * the log.
 *
 * Phase 1-2 contract: **no production caller invokes this yet.**
 * heartbeat.ts and dream.ts still own their markdown rendering.
 * Phase 4 wires them through this renderer once at least Codex
 * and Claude SDK emit native AgentEvents (Phase 3.x).
 *
 * Output shape (one block per event type)
 * ───────────────────────────────────────
 *
 *   run_started        →  ` ▶ Run started`            (single line)
 *   text_delta         →  buffered into the assistant_message section
 *   assistant_message  →  fenced markdown block
 *   reasoning          →  collapsed `<details>` block
 *   tool_call          →  `### Tool call: <name>`     + indented JSON
 *   tool_result        →  appended under the matching tool_call's block
 *   usage              →  ` ▸ Usage: in=… out=… cache=…`
 *   model_swapped      →  ` ⚠ Model swapped: <from> → <to> (<reason>)`
 *   warning            →  ` ⚠ <message>`
 *   error              →  `### Error (<kind>, retryable=<bool>)` + message
 *   completed          →  ` ✓ Completed in <durationMs>ms`
 *
 * The renderer is **append-only** — events stream in, markdown
 * fragments stream out. No buffering across event types; the
 * caller can flush partial output to disk as each fragment lands
 * (real-time tail-friendly).
 *
 * `streamLog(stream, sink)` is the typical entry point — drains
 * the stream, calls `sink(fragment)` for every produced markdown
 * fragment. Returns the final `AgentResult` (or throws on error).
 *
 * Lower-level: `renderEvent(event, state)` returns the fragment
 * for one event and a new state object (immutable update). Used
 * by tests and by callers that want to interleave their own
 * markdown.
 */

import {
  type AgentEvent,
  type AgentError,
  type AgentResult,
  type UsageSnapshot,
} from "./events.js";

/**
 * Renderer state carried across events. Tool calls are buffered
 * by id so `tool_result` events can find their matching call's
 * block.
 */
export interface RenderState {
  /** Maps tool_use_id → header line we already emitted, for matching. */
  toolCallHeaders: Map<string, string>;
  /** Accumulator for unblocked text_delta events. */
  pendingTextDelta: string;
  /** Whether we've seen a terminator (completed | error) yet. */
  finished: boolean;
}

export function freshRenderState(): RenderState {
  return {
    toolCallHeaders: new Map(),
    pendingTextDelta: "",
    finished: false,
  };
}

/**
 * One renderer pass: take an event + the current state, return
 * the markdown fragment and the new state.
 *
 * Pure function (state is replaced via shallow copy; the input
 * state isn't mutated) so callers can replay events without side
 * effects.
 */
export function renderEvent(
  event: AgentEvent,
  state: RenderState,
): { fragment: string; state: RenderState } {
  const next = cloneState(state);

  switch (event.type) {
    case "run_started":
      return { fragment: " ▶ Run started\n", state: next };

    case "text_delta":
      // Don't flush per-delta — buffer until a terminator OR an
      // assistant_message event so the log doesn't churn one line
      // per token.
      next.pendingTextDelta += event.text;
      return { fragment: "", state: next };

    case "assistant_message": {
      const flushed = flushPendingText(next);
      return {
        fragment: flushed + renderAssistantMessage(event.text),
        state: next,
      };
    }

    case "reasoning":
      return {
        fragment: renderReasoning(event.text, event.signature),
        state: next,
      };

    case "tool_call": {
      const flushed = flushPendingText(next);
      const header = `### Tool call: ${event.name}`;
      next.toolCallHeaders.set(event.id, header);
      return {
        fragment:
          flushed +
          `${header}\n\n` +
          "```json\n" +
          safeJson(event.input) +
          "\n```\n\n",
        state: next,
      };
    }

    case "tool_result": {
      // If we have a matching header, render under it; otherwise
      // emit a freestanding fragment. Stream renderers can't
      // back-edit prior output so we annotate forward.
      const header = next.toolCallHeaders.get(event.id);
      const label = header
        ? `**Tool result** (${event.name})`
        : `### Tool result: ${event.name}`;
      const body = event.error
        ? `Error: ${event.error}\n`
        : "```json\n" + safeJson(event.result) + "\n```\n";
      return {
        fragment: `${label}\n\n${body}\n`,
        state: next,
      };
    }

    case "usage":
      return {
        fragment: ` ▸ Usage: ${formatUsage(event.usage)}\n`,
        state: next,
      };

    case "model_swapped":
      return {
        fragment: ` ⚠ Model swapped: ${event.from} → ${event.to} (${event.reason})\n`,
        state: next,
      };

    case "warning":
      return {
        fragment: ` ⚠ ${event.message}\n`,
        state: next,
      };

    case "error": {
      const flushed = flushPendingText(next);
      next.finished = true;
      return {
        fragment: flushed + renderError(event.error),
        state: next,
      };
    }

    case "completed": {
      const flushed = flushPendingText(next);
      next.finished = true;
      const duration = event.result?.durationMs ?? 0;
      const usageLine = event.result?.usage
        ? ` (final: ${formatUsage(event.result.usage)})`
        : "";
      return {
        fragment: flushed + ` ✓ Completed in ${duration}ms${usageLine}\n`,
        state: next,
      };
    }
  }
}

/**
 * Sink callback receives each markdown fragment as it's
 * produced. The renderer calls it inside the for-await loop, so
 * the sink can perform async I/O (file append) and be awaited.
 */
export type LogSink = (fragment: string) => Promise<void> | void;

/**
 * Drain the event stream into the sink, producing markdown
 * fragments. Returns the final `AgentResult` from the
 * `completed` event when one arrives, or `undefined` when the
 * stream ends without a terminator.
 *
 * Throws on `error` events with a `LogRendererError` carrying
 * the original `AgentError`. The error markdown IS flushed to
 * the sink before the throw so log readers see what failed.
 */
export class LogRendererError extends Error {
  readonly agentError: AgentError;
  constructor(error: AgentError) {
    super(`Agent run failed: ${error.kind} — ${error.message}`);
    this.name = "LogRendererError";
    this.agentError = error;
  }
}

export async function streamLog(
  stream: AsyncIterable<AgentEvent>,
  sink: LogSink,
): Promise<AgentResult | undefined> {
  let state = freshRenderState();
  let finalResult: AgentResult | undefined;

  for await (const event of stream) {
    const { fragment, state: next } = renderEvent(event, state);
    state = next;
    if (fragment) await sink(fragment);
    if (event.type === "completed") finalResult = event.result;
    if (event.type === "error") {
      throw new LogRendererError(event.error);
    }
  }

  // Flush any trailing pending text on stream end without
  // terminator (Phase 3.x backends should always emit completed
  // — this is the defensive path).
  if (!state.finished && state.pendingTextDelta) {
    await sink(renderAssistantMessage(state.pendingTextDelta));
  }

  return finalResult;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function cloneState(state: RenderState): RenderState {
  return {
    toolCallHeaders: new Map(state.toolCallHeaders),
    pendingTextDelta: state.pendingTextDelta,
    finished: state.finished,
  };
}

function flushPendingText(state: RenderState): string {
  if (!state.pendingTextDelta) return "";
  const flushed = renderAssistantMessage(state.pendingTextDelta);
  state.pendingTextDelta = "";
  return flushed;
}

function renderAssistantMessage(text: string): string {
  if (!text) return "";
  return `${text.endsWith("\n") ? text : text + "\n"}\n`;
}

function renderReasoning(text: string, signature?: string): string {
  const summary = signature ? `Reasoning (${signature})` : "Reasoning";
  return `<details><summary>${summary}</summary>\n\n${text.trim()}\n\n</details>\n\n`;
}

function renderError(error: AgentError): string {
  return (
    `### Error (${error.kind}, retryable=${error.retryable})\n\n` +
    `${error.message}\n\n` +
    (error.raw ? "```\n" + error.raw + "\n```\n\n" : "")
  );
}

function formatUsage(usage: UsageSnapshot): string {
  const parts = [
    `in=${usage.inputTokens}`,
    `out=${usage.outputTokens}`,
    `cacheR=${usage.cacheRead}`,
    `cacheW=${usage.cacheWrite}`,
  ];
  if (usage.modelId) parts.push(`model=${usage.modelId}`);
  return parts.join(" ");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
