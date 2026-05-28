/**
 * Shared error-recovery dispatcher.
 *
 * Every backend's handler ends its `try { ... } catch (err) { ... }`
 * block with the same `classifyRetry` decision tree:
 *
 *   1. `reset_and_retry` (session_expired / context_length) — reset
 *      the session and recurse.
 *   2. `fallback_model` (retryable + fallback configured) — flip
 *      `chat-settings.model` transiently and recurse.
 *   3. `propagate` — let the caller throw.
 *
 * The four backends each duplicated ~30 lines of this — same logic,
 * different log-line prefix. Centralising it here means a future
 * tweak (e.g. adding a third decision kind, changing the
 * transient-model-flip semantics) lands once instead of four times,
 * and the per-backend handlers reduce to a single function call.
 *
 * Caveat: this is the GENERIC recovery path. Backend-specific
 * fallbacks (e.g. `maybeFallbackForChatGptMismatch` in codex) still
 * live in the backend handler — they're a different decision and run
 * BEFORE this one.
 */

import type { QueryParams, QueryResult } from "../../core/types.js";
import { classify, type TalonError } from "../../core/errors.js";
import { logWarn } from "../../util/log.js";
import { incrementCounter } from "../../util/metrics.js";
import { resetSession } from "../../storage/sessions.js";
import { classifyRetry } from "./model-retry.js";

/** Inputs for `applyRetryDecision`. */
export interface ApplyRetryDecisionInputs {
  /** The error caught by the backend's handler. */
  err: unknown;
  /** Active chat id (for log lines + session reset). */
  chatId: string;
  /** Model that was active when the error fired. */
  activeModel: string;
  /** True when the current call is already a retry (short-circuits). */
  retried: boolean;
  /** Original `handleMessage` params — used for the recursive retry. */
  params: QueryParams;
  /**
   * Backend's recursive entry — passed as a callback so we don't have
   * to depend on each backend module. Each backend calls this with its
   * own `handleMessage`.
   */
  recurseWithRetried: (params: QueryParams) => Promise<QueryResult>;
  /**
   * Backend label for log-line prefixes (`"Kilo"`, `"OpenCode"`,
   * `"Codex"`, `"Claude"`). When omitted or empty the prefix is
   * dropped — matches the claude-sdk historical behaviour.
   */
  backendLabel?: string;
  /**
   * Word used in the reset_and_retry log line. Codex resets a "thread"
   * while the remote-server / claude backends reset a "session"; the
   * helper takes whatever the backend prefers.
   */
  resetNoun?: "session" | "thread";
}

/** Outcome — undefined means the caller should propagate the classified error. */
export interface ApplyRetryDecisionResult {
  /**
   * Set when the helper retried — caller `return retry`s this value
   * directly from its handler.
   */
  retry?: QueryResult;
  /**
   * Set when the helper decided NOT to retry — caller should
   * `throw classified` to propagate.
   */
  classified: TalonError;
}

/**
 * Run the shared retry-decision logic.
 *
 * Side effects (when a retry fires):
 *   - `incrementCounter('errors.<reason>')` exactly once per call.
 *   - `resetSession(chatId)` before recursion.
 *   - For `fallback_model`: transient `setChatModel(chatId, fallback)`
 *     during recursion, then restored to the original in `finally`.
 *
 * When the decision is `propagate`, returns `{classified}` only — the
 * caller throws.
 */
export async function applyRetryDecision(
  inputs: ApplyRetryDecisionInputs,
): Promise<ApplyRetryDecisionResult> {
  const {
    err,
    chatId,
    activeModel,
    retried,
    params,
    recurseWithRetried,
    backendLabel,
    resetNoun = "session",
  } = inputs;

  const classified = classify(err);
  incrementCounter(`errors.${classified.reason ?? "unknown"}`);

  const decision = classifyRetry({
    error: classified,
    activeModel,
    retried,
  });

  const prefix = backendLabel ? `${backendLabel} ` : "";

  if (decision.kind === "reset_and_retry") {
    logWarn(
      "agent",
      `[${chatId}] ${prefix}${decision.reason}, resetting ${resetNoun} and retrying`,
    );
    resetSession(chatId);
    return { retry: await recurseWithRetried(params), classified };
  }

  if (decision.kind === "fallback_model") {
    logWarn(
      "agent",
      `[${chatId}] ${classified.reason}, falling back to ${decision.fallbackModelId}`,
    );
    resetSession(chatId);
    return {
      retry: await recurseWithRetried({
        ...params,
        model: decision.fallbackModelId,
      }),
      classified,
    };
  }

  // `propagate` — caller throws `classified`.
  return { classified };
}
