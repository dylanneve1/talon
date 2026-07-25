/**
 * Shared error-recovery dispatcher.
 *
 * Every backend's handler ends its `try { ... } catch (err) { ... }`
 * block with the same `classifyRetry` decision tree:
 *
 *   1. `reset_and_retry` (session_expired / context_length) — reset
 *      the session and recurse.
 *   2. `fallback_model` (retryable + fallback configured) — recurse
 *      with the fallback model threaded through the retry's params.
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

import type { QueryParams, QueryResult } from "./handler-types.js";
import { classify, type TalonError } from "../../core/errors.js";
import { logWarn } from "../../util/log.js";
import { incrementCounter } from "../../storage/metrics.js";
import { resetSession } from "../../storage/sessions.js";
import { classifyRetry } from "./model-retry.js";
import type { AgentEvent } from "../../core/agent-runtime/events.js";

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
 *   - For `fallback_model`: the fallback model id is spread into the
 *     recursion's params (`params.model` outranks chat settings).
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

// ── Generator-shaped variant ────────────────────────────────────────────────

/** Inputs for `applyRetryDecisionStream`. */
export interface StreamRetryInputs {
  /** Error caught inside the caller's generator. */
  err: unknown;
  /** Active chat id (for log lines + session reset). */
  chatId: string;
  /** Model that was active when the error fired. */
  activeModel: string;
  /** True when the current call is already a retry (short-circuits). */
  retried: boolean;
  /**
   * Builds the recursive event stream. Called once when the helper
   * decides to retry — yielded via `yield*` so the caller's generator
   * transparently delegates to it. For `fallback_model` decisions the
   * fallback model id is passed through; the builder must thread it
   * into the retry's params (`params.model` outranks chat settings,
   * so a transient `setChatModel` flip would be a silent no-op).
   */
  buildRetryStream: (fallbackModelId?: string) => AsyncIterable<AgentEvent>;
  /** Backend label for log-line prefixes (`"Kilo"`, `"Codex"` …). */
  backendLabel?: string;
  /**
   * Word used in the reset_and_retry log line. Codex resets a "thread"
   * while remote-server / claude backends reset a "session".
   */
  resetNoun?: "session" | "thread";
}

/** Outcome `applyRetryDecisionStream` returns from its generator. */
export interface StreamRetryResult {
  /**
   * True when the helper recursed (the recursive stream was already
   * yielded into the caller). Caller may finish its generator.
   */
  retried: boolean;
  /**
   * The classified error. When `retried` is false the caller should
   * yield an `error` event derived from this and return.
   */
  classified: TalonError;
}

/**
 * Generator-shaped equivalent of `applyRetryDecision`. The caller
 * uses `yield* applyRetryDecisionStream({...})` so the recursive
 * retry's events flow into the outer stream transparently. Side
 * effects (counter increment, session reset, fallback model threaded
 * through the retry) match the callback-shaped helper exactly.
 *
 * The terminating value (`AsyncGenerator` 2nd type param) tells the
 * caller whether to emit a final `error` event or just return.
 */
export async function* applyRetryDecisionStream(
  inputs: StreamRetryInputs,
): AsyncGenerator<AgentEvent, StreamRetryResult, void> {
  const {
    err,
    chatId,
    activeModel,
    retried,
    buildRetryStream,
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
    yield* buildRetryStream();
    return { retried: true, classified };
  }

  if (decision.kind === "fallback_model") {
    logWarn(
      "agent",
      `[${chatId}] ${classified.reason}, falling back to ${decision.fallbackModelId}`,
    );
    resetSession(chatId);
    yield* buildRetryStream(decision.fallbackModelId);
    return { retried: true, classified };
  }

  // `propagate` — caller should yield an `error` event and return.
  return { retried: false, classified };
}
