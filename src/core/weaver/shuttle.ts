/**
 * Shuttle — carries the weft across the warp: consumes a backend's
 * canonical `AgentEvent` stream and forwards every event to the
 * frontend's `onEvent` sink (no callback bridge, no back-translation).
 *
 * The Shuttle owns the three stream-consumption invariants so no caller
 * can get them subtly wrong:
 *
 *   - **ordering** — events are awaited in stream order, so a consumer
 *     that needs serial delivery gets it;
 *   - **ack settlement** — `assistant_message.deliveryAck` is ALWAYS
 *     settled, even when no `onEvent` sink is supplied or the sink
 *     ignores the event. Otherwise the callback-shaped backend
 *     (handler-to-events) blocks forever awaiting delivery
 *     confirmation. The frontend's job is just to deliver and throw on
 *     failure; the Shuttle maps that onto the ack (resolve on success →
 *     block delivered; reject on throw → backend retries, e.g. Codex
 *     oversized-message path);
 *   - **terminators** — the `completed` event's `AgentResult` is
 *     captured for the return value, and an `error` terminator is
 *     rethrown as `AgentRunError` so callers' catch paths keep working.
 */

import {
  AgentRunError,
  type AgentEvent,
  type AgentResult,
} from "../agent-runtime/events.js";

export type EventSink = (event: AgentEvent) => void | Promise<void>;

/**
 * Pump the stream to completion. Returns the `completed` event's
 * result (if the backend emitted one); throws `AgentRunError` when the
 * stream terminates with an `error` event.
 */
export async function carryTurnEvents(
  stream: AsyncIterable<AgentEvent>,
  onEvent?: EventSink,
): Promise<AgentResult | undefined> {
  let agentResult: AgentResult | undefined;
  for await (const event of stream) {
    if (event.type === "completed") {
      agentResult = event.result;
    }

    if (event.type === "assistant_message" && event.deliveryAck) {
      try {
        await onEvent?.(event);
        event.deliveryAck.resolve();
      } catch (err) {
        event.deliveryAck.reject(err);
      }
      continue;
    }

    await onEvent?.(event);
    if (event.type === "error") {
      throw new AgentRunError(event.error);
    }
  }
  return agentResult;
}
