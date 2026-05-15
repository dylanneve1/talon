/**
 * Kilo SSE event processing — pure helpers used by the streaming handler.
 *
 * Extracted from `handler.ts` so the per-event logic can be unit-tested
 * without spinning up a real KiloClient. The handler still owns the
 * subscription loop and SSE iteration; this module owns "given one
 * event + current state, what does Talon do with it".
 *
 * The two key functions:
 *
 *   - `processStreamEvent(event, ctx)` — one SSE event in, state mutated
 *     + callbacks fired out. Returns a tag that says whether the loop
 *     should keep iterating or stop (`session.turn.close` / `session.idle`).
 *   - `finalizePartsIntoState(parts, ctx)` — once the sync `session.prompt`
 *     returns its authoritative parts list, backfill anything SSE missed.
 *
 * Both are stateless beyond their `state` argument — easy to call with
 * a hand-built event object from a vitest test.
 */

import {
  appendText,
  closeCurrentSegment,
  recordToolUse,
  type StreamState,
} from "../shared/index.js";
import { extractPartsSummary } from "./sessions.js";

// ── Streaming timing ───────────────────────────────────────────────────────

/**
 * Minimum interval (ms) between `onStreamDelta` callbacks. Throttles the
 * Telegram edit_message calls so the frontend doesn't spam updates and
 * trip rate limits during fast-token generation.
 */
export const STREAM_INTERVAL_MS = 1000;

// ── Types ──────────────────────────────────────────────────────────────────

/** Tag returned by `processStreamEvent` describing what the loop should do. */
export type ProcessEventOutcome =
  | { kind: "continue" }
  | { kind: "stop"; reason: "turn.close" | "idle" | "out_of_scope" }
  | { kind: "terminator_fired"; toolName: string };

/** Common context passed to both helpers below. */
export interface EventProcessingContext {
  /** Session id we're scoped to — events for other sessions are dropped. */
  sessionId: string;
  /** Stream state accumulator (shared/). */
  state: StreamState;
  /** Tool-call ids we've already fired callbacks for. */
  seenToolCallIds: Set<string>;
  /** Optional progress / streaming callback. */
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  /** Optional pre-tool text emitter. */
  onTextBlock?: (text: string) => Promise<void>;
  /** Optional tool-use observer. */
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
}

// ── Event processing ───────────────────────────────────────────────────────

/**
 * Process one SSE event from Kilo's `global.event()` stream.
 *
 * Behaviour by event type:
 *
 *   - `message.part.delta` — append to state, throttle a `onStreamDelta`
 *     fire. Thinking deltas don't accumulate into the response buffer.
 *   - `message.part.updated` for a `ToolPart` — fire `onTextBlock` for
 *     any pre-tool segment, then `recordToolUse` (which captures
 *     delivered text + flips turnTerminated for terminators) + `onToolUse`.
 *     Returns `terminator_fired` so the caller can abort the session.
 *   - `session.turn.close` / `session.idle` — return `stop` so the
 *     subscription loop exits cleanly.
 *   - `session.error` — observed but not mutated here; caller logs.
 *
 * Events for other sessions return `out_of_scope` — caller continues.
 */
export async function processStreamEvent(
  event: { type?: string; properties?: Record<string, unknown> },
  ctx: EventProcessingContext,
): Promise<ProcessEventOutcome> {
  if (!event || typeof event !== "object") return { kind: "continue" };
  const props = event.properties ?? {};
  // Scope to our session only
  const evtSessionID =
    typeof props.sessionID === "string" ? props.sessionID : undefined;
  if (evtSessionID && evtSessionID !== ctx.sessionId) {
    return { kind: "stop", reason: "out_of_scope" };
  }

  switch (event.type) {
    case "message.part.delta": {
      return processPartDelta(props, ctx);
    }
    case "message.part.updated": {
      return processPartUpdate(props, ctx);
    }
    case "session.turn.close": {
      return { kind: "stop", reason: "turn.close" };
    }
    case "session.idle": {
      return { kind: "stop", reason: "idle" };
    }
    default:
      return { kind: "continue" };
  }
}

function processPartDelta(
  props: Record<string, unknown>,
  ctx: EventProcessingContext,
): ProcessEventOutcome {
  const field = typeof props.field === "string" ? props.field : "";
  const delta = typeof props.delta === "string" ? props.delta : "";
  if (!delta) return { kind: "continue" };
  if (field === "text") {
    appendText(ctx.state, delta);
    maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "text");
  } else if (field === "thinking" || field === "reasoning") {
    // Thinking deltas don't accumulate into response text; just signal
    // "model is still working" for UI feedback.
    maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "thinking");
  }
  return { kind: "continue" };
}

async function processPartUpdate(
  props: Record<string, unknown>,
  ctx: EventProcessingContext,
): Promise<ProcessEventOutcome> {
  const part = props.part as Record<string, unknown> | undefined;
  if (!part || part.type !== "tool") return { kind: "continue" };

  const callID = typeof part.callID === "string" ? part.callID : "";
  const toolName = typeof part.tool === "string" ? part.tool : "tool";
  const stateObj = part.state as
    | { status?: string; input?: Record<string, unknown> }
    | undefined;

  // Fire onToolUse ONCE when the tool transitions to running or completed
  // with input available. Subsequent state changes don't re-fire.
  if (
    !stateObj ||
    (stateObj.status !== "running" && stateObj.status !== "completed") ||
    !callID ||
    ctx.seenToolCallIds.has(callID)
  ) {
    return { kind: "continue" };
  }

  ctx.seenToolCallIds.add(callID);
  const input = stateObj.input ?? {};

  // Emit pre-tool progress text BEFORE recording the tool — so the user
  // sees "let me check..." land before the tool's typing indicator.
  const progress = closeCurrentSegment(ctx.state);
  if (progress && ctx.onTextBlock) {
    try {
      await ctx.onTextBlock(progress);
    } catch {
      /* non-fatal — never break the stream loop on a UI callback */
    }
  }
  recordToolUse(ctx.state, toolName, input);
  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch {
      /* non-fatal */
    }
  }
  if (ctx.state.turnTerminated) {
    return { kind: "terminator_fired", toolName };
  }
  return { kind: "continue" };
}

/**
 * Fire `onStreamDelta` if at least `STREAM_INTERVAL_MS` has elapsed since
 * the last call. Throttles the callback to keep Telegram happy.
 *
 * Mutates `state.lastStreamUpdate` on every successful fire.
 */
export function maybeFireStreamDelta(
  state: StreamState,
  onStreamDelta: EventProcessingContext["onStreamDelta"],
  phase: "thinking" | "text",
): void {
  if (!onStreamDelta) return;
  const now = Date.now();
  if (now - state.lastStreamUpdate < STREAM_INTERVAL_MS) return;
  state.lastStreamUpdate = now;
  try {
    onStreamDelta(state.currentBlockText, phase);
  } catch {
    /* non-fatal */
  }
}

// ── Sync-response parts backfill ───────────────────────────────────────────

/** Inputs for `finalizePartsIntoState`. */
export interface FinalizePartsInputs {
  parts: Array<Record<string, unknown>>;
  state: StreamState;
  seenToolCallIds: Set<string>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
}

/**
 * Drain the sync `session.prompt()` response into the stream state.
 *
 * SSE may have already captured most of this content, but `prompt()`'s
 * parts list is authoritative — anything SSE missed (e.g. text emitted
 * after the SSE socket dropped, or the whole turn if SSE subscribe
 * failed) needs to land in state before we return.
 *
 * Two modes:
 *   - SSE captured something (`allResponseText.length > 0`) — only
 *     replay tools we haven't seen.
 *   - SSE captured nothing — drive the full reconstruction through state
 *     mutators (text + tools).
 *
 * Returns the number of tool calls processed this pass (mostly for tests).
 */
export function finalizePartsIntoState(inputs: FinalizePartsInputs): {
  toolsProcessed: number;
} {
  const { parts, state, seenToolCallIds, onToolUse } = inputs;
  let toolsProcessed = 0;

  const sseCapturedText = state.allResponseText.length > 0;

  if (!sseCapturedText) {
    // SSE missed — drive the full reconstruction through state mutators.
    // `recordToolUse` handles the toolCalls increment + delivered-text
    // capture + turnTerminated flag, so we don't pre-seed `toolCalls`
    // from `extractPartsSummary` (would double-count).
    const { text } = extractPartsSummary(parts);

    for (const part of parts) {
      if (part.type !== "tool") continue;
      const stateObj = part.state as
        | { status?: string; input?: Record<string, unknown> }
        | undefined;
      const callID = typeof part.callID === "string" ? part.callID : "";
      const toolName = typeof part.tool === "string" ? part.tool : "tool";
      if (callID && seenToolCallIds.has(callID)) continue;
      if (stateObj?.input) {
        if (callID) seenToolCallIds.add(callID);
        recordToolUse(state, toolName, stateObj.input);
        toolsProcessed++;
        if (onToolUse) {
          try {
            onToolUse(toolName, stateObj.input);
          } catch {
            /* non-fatal */
          }
        }
      }
    }

    if (text) {
      appendText(state, text);
    }
    return { toolsProcessed };
  }

  // SSE captured most of it; pick up any tools SSE missed.
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const callID = typeof part.callID === "string" ? part.callID : "";
    if (!callID || seenToolCallIds.has(callID)) continue;

    seenToolCallIds.add(callID);
    const stateObj = part.state as
      | { status?: string; input?: Record<string, unknown> }
      | undefined;
    const toolName = typeof part.tool === "string" ? part.tool : "tool";
    if (stateObj?.input) {
      recordToolUse(state, toolName, stateObj.input);
      toolsProcessed++;
      if (onToolUse) {
        try {
          onToolUse(toolName, stateObj.input);
        } catch {
          /* non-fatal */
        }
      }
    }
  }
  return { toolsProcessed };
}
