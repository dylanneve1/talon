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
import { log } from "../../util/log.js";
import { incrementCounter } from "../../util/metrics.js";
import { stripMcpPrefix } from "../../core/tools/index.js";

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

  // Count this event for the per-turn diagnostic summary the handler logs
  // at end-of-turn. Helps debug "stuck" turns by showing which event types
  // actually fired (e.g. `delta×42 part.updated×1` vs zero events).
  if (typeof event.type === "string") {
    ctx.state.eventCounts[event.type] =
      (ctx.state.eventCounts[event.type] ?? 0) + 1;
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
  const partID = typeof props.partID === "string" ? props.partID : "";
  if (!delta) return { kind: "continue" };

  // `field: "text"` deltas can fire for either a TextPart (user-facing
  // reply) OR a ReasoningPart (private scratchpad — both part types use
  // a `text` field). The delta event itself doesn't say which one. We
  // accumulate optimistically here for streaming UX continuity, then
  // `finalizePartsIntoState` rewrites `state.allResponseText` from the
  // authoritative parts list (text-parts only) at end-of-turn — so any
  // reasoning content that leaked in during the stream gets cleaned up
  // before the handler reads it. The exception: when we already know
  // the partID belongs to a reasoning/thinking part (from a prior
  // message.part.updated), don't pollute allResponseText now either.
  if (field === "text") {
    const partType = partID ? ctx.state.partTypes.get(partID) : undefined;
    if (partType === "reasoning" || partType === "thinking") {
      maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "thinking");
    } else {
      appendText(ctx.state, delta);
      maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "text");
    }
  } else if (field === "thinking" || field === "reasoning") {
    // Explicit reasoning/thinking field — never accumulate.
    maybeFireStreamDelta(ctx.state, ctx.onStreamDelta, "thinking");
  }
  return { kind: "continue" };
}

async function processPartUpdate(
  props: Record<string, unknown>,
  ctx: EventProcessingContext,
): Promise<ProcessEventOutcome> {
  const part = props.part as Record<string, unknown> | undefined;
  if (!part) return { kind: "continue" };

  // Track every part's type by id so processPartDelta can distinguish
  // text-part text content from reasoning-part text content (Kilo uses
  // the same `text` field name in both).
  const partType = typeof part.type === "string" ? part.type : "";
  const partID = typeof part.id === "string" ? part.id : "";
  if (partID && partType) {
    ctx.state.partTypes.set(partID, partType);
  }

  if (part.type !== "tool") return { kind: "continue" };

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
  // Count every tool the model calls — parity with claude-sdk which
  // increments per tool. Without this, kilo only ever recorded the
  // terminator (end_turn / send / react), so `read_history`, `get_*`,
  // etc. never showed up in `/metrics`.
  incrementCounter(`tool_calls.${stripMcpPrefix(toolName)}`);
  recordToolUse(ctx.state, toolName, input);
  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch {
      /* non-fatal */
    }
  }
  if (ctx.state.turnTerminated) {
    log(
      "agent",
      `[Kilo] terminator fired: ${describeToolCall(toolName, input)}`,
    );
    return { kind: "terminator_fired", toolName };
  }
  return { kind: "continue" };
}

/**
 * One-line summary of a tool call for diagnostic logs. Shows the args
 * operators care about (text length, type, emoji) without dumping the
 * whole JSON payload. Long text inputs are summarised by character count.
 */
function describeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const parts: string[] = [toolName];
  if (typeof input.type === "string") parts.push(`type=${input.type}`);
  if (typeof input.text === "string") {
    parts.push(`text=${input.text.length}chars`);
  }
  if (typeof input.emoji === "string") parts.push(`emoji=${input.emoji}`);
  if (typeof input.end_turn === "boolean") {
    parts.push(`end_turn=${input.end_turn}`);
  }
  return parts.join(" ");
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
 * The `parts` list returned by `session.prompt()` is the authoritative
 * snapshot of what the model produced this turn. Kilo emits parts in
 * one of three categories that map to Talon's delivery model:
 *
 *   - `text` — user-facing reply. Kilo models (DeepSeek, GLM, etc.)
 *     emit text parts as their natural delivery; they don't call
 *     `end_turn` the way Claude does. We accumulate text-part content
 *     into `state.allResponseText` so the handler ships it via
 *     `onTextBlock` after the turn closes.
 *   - `tool` — side-effect tool call (end_turn for explicit close,
 *     send for rich content, react for emoji, plus arbitrary plugin
 *     tools). Goes through `recordToolUse` which sets
 *     `turnTerminated` for end_turn and captures delivered-text norms
 *     for dedup.
 *   - `reasoning` / `step-start` / `step-finish` / etc. — internal
 *     plumbing or scratchpad. Ignored.
 *
 * Why we re-extract text here even when SSE captured deltas: SSE
 * deltas can arrive before the matching `message.part.updated` (so we
 * don't yet know the part type) or after the connection blips —
 * walking the final parts list is the safe source of truth. We
 * replace any partial SSE-accumulated text with the part-walk text to
 * avoid double-counting or partial-fragment leaks.
 *
 * Returns the number of tool calls processed this pass (mostly for tests).
 */
export function finalizePartsIntoState(inputs: FinalizePartsInputs): {
  toolsProcessed: number;
  syntheticErrorText?: string;
} {
  const { parts, state, seenToolCallIds, onToolUse } = inputs;
  let toolsProcessed = 0;

  // Authoritative text from text parts only — `extractPartsSummary` already
  // filters to `part.type === "text"`, so reasoning content can't leak in
  // even if a delta classifier missed it earlier in the turn. It also
  // peels off `synthetic: true` parts (Kilo's internal failure messages
  // like "model hit its output limit while reasoning") and surfaces them
  // via `syntheticErrorText` so the caller can show a Talon error
  // instead of shipping the raw Kilo string as a chat reply.
  const summary = extractPartsSummary(parts);
  if (summary.text) {
    state.allResponseText = summary.text;
    state.lastTrailingText = summary.text;
    state.currentBlockText = "";
  } else if (summary.syntheticErrorText) {
    // No real text part — make sure SSE-accumulated speculative text
    // doesn't leak through as if it were the reply.
    state.allResponseText = "";
    state.lastTrailingText = "";
    state.currentBlockText = "";
  }
  if (summary.syntheticErrorText) {
    state.syntheticError = summary.syntheticErrorText;
  }

  // Process tool parts — recordToolUse handles the toolCalls increment,
  // delivered-text capture, and the turnTerminated flag for end_turn.
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

  return {
    toolsProcessed,
    ...(summary.syntheticErrorText
      ? { syntheticErrorText: summary.syntheticErrorText }
      : {}),
  };
}
