/**
 * Flow-violation detection and synthetic-retry construction.
 *
 * "Flow violation" = the model produced text content in its output stream
 * (private scratchpad by contract) without routing it through a delivery
 * tool (`end_turn` / `send(type="text")` / `react`). The text would be
 * dropped invisibly, so we surface the miss by re-prompting the model
 * once with a synthetic system reminder describing the correct flow.
 *
 * The retry is one-shot: a second flow violation after the reminder is
 * accepted as a silent drop + telemetry counter. Without the cap, models
 * that habitually pair prose with the wrong tool would loop indefinitely.
 *
 * Backends call `detectFlowViolation(...)` after the stream loop ends.
 * If it returns a reminder string, the handler re-runs the message with
 * that reminder text in place of the original prompt (and `retried = true`
 * so the next call short-circuits the retry path).
 */

import { isDuplicateOfDelivered } from "./delivered-text.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** The synthetic system reminder shipped back to the model on a flow violation. */
export const FLOW_VIOLATION_REMINDER =
  "[FLOW VIOLATION] Your previous turn ended without a delivery tool, so the " +
  "user saw nothing. Replies must go through a tool call: " +
  "`end_turn(text=...)` for a final reply, " +
  "`end_turn()` (no args) to close silently, " +
  "`send(...)` for mid-turn rich content (photos, polls, etc.), or " +
  "`react(emoji=...)` for an emoji acknowledgement. " +
  "Tool calls alone do not close the turn. Retry now using the correct tool call.";

export const FLOW_VIOLATION_MAX_RETRIES = 3;

// ── Public API ──────────────────────────────────────────────────────────────

/** Inputs needed to decide whether a turn violated the delivery contract. */
export type FlowViolationInputs = {
  /** Text accumulated after the last tool call (or the full text if none). */
  trailingText: string;
  /** Whether a turn-terminator tool already fired in this turn. */
  turnTerminated: boolean;
  /** Already-delivered text norms used for dedup. */
  deliveredTextNorms: readonly string[];
  /** Number of tool calls observed in this turn. */
  toolCalls?: number;
  /** Whether this is already a retry (prevents looping). */
  retried: boolean;
  /** Number of synthetic flow-violation retries already attempted. */
  retryCount?: number;
  /** Maximum synthetic flow-violation retries before accepting the drop. */
  maxRetries?: number;
  /**
   * Reminder text to ship on retry. Defaults to the legacy
   * telegram-shaped `FLOW_VIOLATION_REMINDER`; backends should pass
   * `buildFlowViolationReminder(frontend)` so the tool names match
   * what's actually registered (Teams has `send_message`, not `send`).
   */
  reminder?: string;
};

/** Outcome of the flow-violation check. */
export type FlowViolationResult =
  | {
      /** True when the model wrote prose and skipped the delivery tool. */
      violated: true;
      /** Trimmed scratchpad prose that would be dropped. */
      trailing: string;
      /** Human-readable reason logged by handlers. */
      reason: string;
      /** Whether the handler should re-prompt with `reminder`. False when retried. */
      shouldRetry: boolean;
      /** Reminder string to send as the next user prompt (when retrying). */
      reminder: string;
    }
  | {
      violated: false;
    };

/**
 * Classify a stream-loop outcome against the delivery contract.
 *
 * A turn is in violation when ALL of the following hold:
 *   - No turn-terminator tool fired (e.g. `end_turn`).
 *   - The model produced either trailing prose or tool calls.
 *   - Any trailing text isn't a duplicate of content already delivered
 *     through a tool call in the same turn.
 *
 * The third condition handles the legitimate "model wrote text AND called
 * `end_turn(text=...)` with the same text" pattern — that's not a missed
 * delivery, it's redundant double-emission. The deliveredTextNorms list
 * captures this and dedup short-circuits the retry.
 */
export function detectFlowViolation(
  inputs: FlowViolationInputs,
): FlowViolationResult {
  const trailing = inputs.trailingText.trim();
  if (inputs.turnTerminated) return { violated: false };
  const toolCalls = inputs.toolCalls ?? 0;
  if (trailing.length === 0 && toolCalls === 0) return { violated: false };
  if (
    trailing.length > 0 &&
    isDuplicateOfDelivered(trailing, inputs.deliveredTextNorms)
  ) {
    return { violated: false };
  }

  const retryCount = inputs.retryCount ?? (inputs.retried ? 1 : 0);
  const maxRetries = inputs.maxRetries ?? FLOW_VIOLATION_MAX_RETRIES;
  const reason =
    trailing.length > 0
      ? `trailing prose (${trailing.length} chars)`
      : `${toolCalls} tool call${toolCalls === 1 ? "" : "s"} with no terminator`;

  return {
    violated: true,
    trailing,
    reason,
    shouldRetry: retryCount < maxRetries,
    reminder: inputs.reminder ?? FLOW_VIOLATION_REMINDER,
  };
}
