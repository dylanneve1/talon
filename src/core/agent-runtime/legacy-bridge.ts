/**
 * `AgentEvent` → legacy `QueryParams` callbacks bridge.
 *
 * The Phase 3 plan says:
 *
 *   > Backend handlers should emit events. Existing UI/log code can
 *   > temporarily render events back into the old shape.
 *
 * This module is the "render back into the old shape" piece. Once
 * a backend handler natively emits `AgentEvent`s, the dispatcher
 * (which still feeds callbacks into the legacy `QueryParams`) can
 * keep working unchanged — Phase 3.x backends pipe their event
 * stream through `pipeEventsToCallbacks` and the legacy
 * `onStreamDelta` / `onTextBlock` / `onToolUse` callbacks get
 * invoked from the events.
 *
 * Phase 1-2 contract: **no production caller invokes this yet.**
 * It's the missing piece that makes Phase 3.x backend rewrites
 * localised to one handler at a time — each backend can switch to
 * native event emission without forcing every consumer downstream
 * to migrate in lockstep.
 *
 * Event → callback mapping
 * ────────────────────────
 *
 *   text_delta            → onStreamDelta(accumulated, "text")
 *   reasoning             → onStreamDelta(accumulated, "thinking")
 *   assistant_message     → onTextBlock(text)
 *   tool_call             → onToolUse(name, input as Record)
 *   completed → returns the final AgentResult (no callback fires;
 *               dispatcher reads the awaited promise instead)
 *   error → throws an Error tagged with the AgentError's classification
 *
 *   run_started / tool_result / usage / model_swapped / warning
 *   are observed but don't currently fan out to legacy callbacks —
 *   the dispatcher doesn't have hooks for them yet, and bridging
 *   shouldn't invent new ones.
 *
 * Accumulators
 * ────────────
 *
 * `onStreamDelta` legacy contract is "accumulated text so far,
 * plus phase". The bridge maintains two accumulators (text +
 * thinking) and reports them per event. `assistant_message`
 * events do NOT reset the text accumulator; they emit the block
 * verbatim via `onTextBlock` and add to the running total so a
 * downstream `text_delta` continues where it left off.
 */

import {
  emptyUsage,
  type AgentError,
  type AgentEvent,
  type AgentResult,
} from "./events.js";

/**
 * Legacy callback bundle from `QueryParams`. The bridge invokes
 * whichever callbacks are present; missing ones are silently
 * skipped. Errors thrown by callbacks are surfaced as failed
 * promises (the bridge does not swallow them).
 */
export interface LegacyCallbacks {
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
}

/**
 * Error thrown when the bridge sees an `error` event in the
 * upstream stream. Carries the `AgentError` so callers can
 * inspect `kind` / `retryable` without re-classifying.
 */
export class BridgedAgentError extends Error {
  readonly kind: AgentError["kind"];
  readonly retryable: boolean;
  readonly raw?: string;

  constructor(error: AgentError) {
    super(error.message);
    this.name = "BridgedAgentError";
    this.kind = error.kind;
    this.retryable = error.retryable;
    this.raw = error.raw;
  }
}

/**
 * Drive the legacy callback bundle from an `AgentEvent` stream.
 *
 * Returns the `AgentResult` from the terminating `completed`
 * event when one is seen, or `undefined` when the stream ends
 * without a completed terminator (the `error` case throws
 * `BridgedAgentError` before returning).
 *
 * Callers MUST `await` this — the legacy `onTextBlock` callback
 * is async and the bridge serialises text-block delivery so the
 * dispatcher's typing-indicator state stays consistent.
 */
export async function pipeEventsToCallbacks(
  stream: AsyncIterable<AgentEvent>,
  callbacks: LegacyCallbacks,
): Promise<AgentResult | undefined> {
  let textAccum = "";
  let thinkingAccum = "";
  let finalResult: AgentResult | undefined;

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta": {
        textAccum += event.text;
        callbacks.onStreamDelta?.(textAccum, "text");
        break;
      }
      case "reasoning": {
        thinkingAccum += event.text;
        callbacks.onStreamDelta?.(thinkingAccum, "thinking");
        break;
      }
      case "assistant_message": {
        if (callbacks.onTextBlock) {
          await callbacks.onTextBlock(event.text);
        }
        // Folding the block into the accumulator keeps subsequent
        // `text_delta` events monotonically growing — the legacy
        // contract assumes `accumulated` never shrinks.
        textAccum += event.text;
        break;
      }
      case "tool_call": {
        const input = isPlainObject(event.input)
          ? (event.input as Record<string, unknown>)
          : {};
        callbacks.onToolUse?.(event.name, input);
        break;
      }
      case "completed": {
        finalResult = event.result;
        break;
      }
      case "error": {
        throw new BridgedAgentError(event.error);
      }
      // No legacy callback equivalents — observed but not bridged.
      case "run_started":
      case "tool_result":
      case "usage":
      case "model_swapped":
      case "warning":
        break;
    }
  }

  return finalResult;
}

/**
 * Best-effort accumulation of an `AgentEvent` stream into a
 * single `AgentResult` without invoking any callbacks.
 *
 * Useful for backends in Phase 3.x that emit events natively but
 * also need to return a `QueryResult` to the legacy
 * `backend.query()` contract until the dispatcher migrates. The
 * dispatcher consumes the returned `AgentResult`; the events are
 * lost (consumer is responsible for piping them separately if
 * needed).
 *
 * When the stream terminates with `error`, throws
 * `BridgedAgentError`. When it terminates with `completed`, returns
 * the event's `result`. When it ends without a terminator, returns
 * a synthesised result with empty text and zero usage — the
 * dispatcher treats this as a silent run.
 */
export async function reduceEventsToResult(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentResult> {
  let text = "";
  let usage = emptyUsage();
  let modelId: string | undefined;
  let durationMs = 0;
  let saw = false;

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "assistant_message":
        text += event.text;
        break;
      case "usage":
        usage = event.usage;
        if (event.usage.modelId) modelId = event.usage.modelId;
        break;
      case "completed":
        saw = true;
        if (event.result) {
          return event.result;
        }
        break;
      case "error":
        throw new BridgedAgentError(event.error);
      default:
        break;
    }
  }

  // No completed event seen — synthesise from observed deltas.
  // Phase 3.x backends should always emit `completed`; falling
  // through here means the stream ended on a non-terminator,
  // which is a backend contract violation but not catastrophic.
  return {
    text,
    durationMs,
    usage,
    ...(modelId ? { modelId } : {}),
    // saw === false means we hit the silent-stream path; the
    // dispatcher will see empty text + zero usage.
    ...(saw ? {} : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
