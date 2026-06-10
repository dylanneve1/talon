/**
 * `AgentEvent` → callback bridge.
 *
 * Backends emit `AgentEvent`s as their native chat-turn output;
 * upstream consumers (the dispatcher, frontend logging) still take
 * delivery via the callback shape (`onStreamDelta` / `onTextBlock`
 * / `onToolUse`). This module is the translator: feed it an event
 * stream and a callback set, get the canonical `AgentResult` back.
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
 *   error → throws `BridgedAgentError` tagged with the
 *           `AgentError`'s classification (`kind`, `retryable`)
 *
 *   run_started / tool_result / usage / model_swapped / warning
 *   are observed but don't fan out to callbacks — they exist for
 *   consumers reading the raw stream (event log renderer, contract
 *   tests).
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

import type { AgentError, AgentEvent, AgentResult } from "./events.js";

/**
 * Callback bundle (mirrors the dispatcher's `ExecuteParams`
 * callback fields). The bridge invokes
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
        try {
          if (callbacks.onTextBlock) {
            await callbacks.onTextBlock(event.text);
          }
          event.deliveryAck?.resolve();
        } catch (err) {
          event.deliveryAck?.reject(err);
          if (!event.deliveryAck) {
            throw err;
          }
        }
        // Folding the block into the accumulator keeps subsequent
        // `text_delta` events monotonically growing — the legacy
        // contract assumes `accumulated` never shrinks.
        textAccum += event.text;
        break;
      }
      case "tool_call": {
        if (
          !isPlainObject(event.input) &&
          event.input !== undefined &&
          event.input !== null
        ) {
          // The legacy onToolUse contract requires Record<string, unknown>, so
          // non-plain-object inputs (e.g. arrays emitted by Phase 3 backends)
          // cannot be forwarded verbatim. Log the data loss so operators can
          // diagnose if a tool receives empty args when it shouldn't.
          const typeLabel = Array.isArray(event.input)
            ? "array"
            : typeof event.input;
          console.warn(
            `[event-bridge] tool_call "${event.name}": input is ${typeLabel}, ` +
              `not a plain object — bridging to {} (legacy onToolUse accepts only Record<string, unknown>).`,
          );
        }
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
