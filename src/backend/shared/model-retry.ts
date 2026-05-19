/**
 * Model-fallback / context-overflow / session-expiry retry decisions.
 *
 * Every backend's handler implements (or *should* implement) the same
 * recovery ladder when a query fails:
 *
 *   1. `session_expired` → reset session, retry once with the same input.
 *   2. `context_length` → reset session, retry once with the same input.
 *   3. Retryable error (`rate_limit` / `overloaded` / `network`) → if a
 *      fallback model is configured for the active model, swap to it
 *      and retry once with the original input.
 *
 * Each step happens at most once per top-level message — the handler
 * passes `_retried = true` on the recursive call so subsequent failures
 * propagate. This module owns the decision logic so all backends share
 * identical recovery semantics.
 *
 * Note: this module does NOT perform the retry itself — it returns a
 * `RetryDecision` and lets the backend handler invoke its own recursive
 * `handleMessage`. The handler owns session state mutations (reset,
 * model swap) because those touch backend-specific storage.
 */

import type { TalonError } from "../../core/errors.js";
import { getFallbackModel } from "../../core/models.js";

// ── Public API ──────────────────────────────────────────────────────────────

/** Categorisation of what the handler should do next after an error. */
export type RetryDecision =
  | { kind: "reset_and_retry"; reason: "session_expired" | "context_length" }
  | { kind: "fallback_model"; fallbackModelId: string }
  | { kind: "propagate" };

/** Inputs for `classifyRetry`. */
export type ClassifyRetryInputs = {
  /** Already-classified error from `classify(err)`. */
  error: TalonError;
  /** The model that was active when the error fired. */
  activeModel: string;
  /** True when this is already a retry — short-circuits all recovery. */
  retried: boolean;
};

/**
 * Decide how to recover from a backend error.
 *
 * Pure function — no side effects, no logging. Callers receive a tagged
 * union describing the action they should take, plus the data needed to
 * execute it.
 */
export function classifyRetry(inputs: ClassifyRetryInputs): RetryDecision {
  if (inputs.retried) return { kind: "propagate" };

  const reason = inputs.error.reason;

  if (reason === "session_expired") {
    return { kind: "reset_and_retry", reason: "session_expired" };
  }
  if (reason === "context_length") {
    return { kind: "reset_and_retry", reason: "context_length" };
  }

  if (inputs.error.retryable) {
    const fallback = getFallbackModel(inputs.activeModel);
    if (fallback) {
      return { kind: "fallback_model", fallbackModelId: fallback };
    }
  }

  return { kind: "propagate" };
}
