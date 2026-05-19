/**
 * Kilo SSE event processing — thin wrapper around
 * `backend/remote-server/events.ts` that binds the Kilo-specific
 * `extractPartsSummary` extractor.
 *
 * The wire-format and event-driven state machine is identical between
 * OpenCode and Kilo (Kilo is a fork of OpenCode and shares the same
 * SSE schema). All the logic lives in the shared module; this file is
 * the Kilo-side configurator + re-export surface for back-compat with
 * existing imports from `./events.js`.
 */

import {
  finalizePartsIntoState as finalizePartsIntoStateShared,
  processStreamEvent as processStreamEventShared,
  STREAM_INTERVAL_MS,
  maybeFireStreamDelta,
  type EventProcessingContext as SharedEventContext,
  type FinalizePartsInputs as SharedFinalizeInputs,
  type ProcessEventOutcome,
} from "../remote-server/events.js";
import { extractPartsSummary } from "./sessions.js";

// ── Re-exports ─────────────────────────────────────────────────────────────

export { STREAM_INTERVAL_MS, maybeFireStreamDelta };
export type { ProcessEventOutcome };

/** Context type, with `backendLabel` defaulted to "Kilo" via the wrappers. */
export type EventProcessingContext = Omit<SharedEventContext, "backendLabel">;

/**
 * Process one Kilo SSE event. Delegates to the shared processor with the
 * Kilo backend label.
 */
export function processStreamEvent(
  event: { type?: string; properties?: Record<string, unknown> },
  ctx: EventProcessingContext,
): Promise<ProcessEventOutcome> {
  return processStreamEventShared(event, { ...ctx, backendLabel: "Kilo" });
}

/** Inputs for the Kilo-side `finalizePartsIntoState`. */
export type FinalizePartsInputs = Omit<
  SharedFinalizeInputs,
  "extractPartsSummary"
>;

/**
 * Drain Kilo's authoritative `session.messages` parts list into the
 * stream state. Delegates to the shared finalizer with the Kilo
 * `extractPartsSummary` extractor (which understands Kilo's
 * `synthetic: true` text-part flag).
 */
export function finalizePartsIntoState(inputs: FinalizePartsInputs): {
  toolsProcessed: number;
  syntheticErrorText?: string;
} {
  return finalizePartsIntoStateShared({ ...inputs, extractPartsSummary });
}
