/**
 * Codex main message handler.
 *
 * Orchestrates the full turn lifecycle on top of `@openai/codex-sdk`'s
 * `Thread.runStreamed`. Shares the non-SDK-specific primitives with
 * the other backends via `../shared/`:
 *
 *   - Stream state accumulator (text, tool calls, trailing prose).
 *   - Tool-use detection + turn-terminator handling
 *     (`end_turn` / `send` / `react`).
 *   - Progress-text emission before each tool call.
 *   - Model fallback on rate-limit / overload / network.
 *   - Context-overflow + session-expiry recovery.
 *   - First-turn system-prompt rebuild + plugin prompt additions.
 *   - `[YYYY-MM-DD HH:MM:SS] [Name] [msg_id:N]` prompt formatting.
 *   - Unified delivery routing
 *     (tool / synthetic-error / text-part / empty).
 *
 * What's Codex-specific (lives here, not in shared):
 *
 *   - Reading events from Codex's `runStreamed` generator
 *     (`thread.started`, `turn.started`, `item.completed`,
 *     `turn.completed`, `turn.failed`, `error`).
 *   - Translating `agent_message` / `mcp_tool_call` items into the
 *     shared stream state.
 *   - Resuming via `codex.resumeThread(id)` for session continuity.
 *
 * Why no `session.abort()`: the Codex SDK's `runStreamed` accepts an
 * `AbortSignal` on the per-call options. We hook it up so a
 * turn-terminator tool can cancel any further model generation the
 * same way Kilo's `oc.session.abort()` does — without burning the
 * wrap-up round-trip.
 */

import type {
  Thread,
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  McpToolCallItem,
  Usage,
} from "@openai/codex-sdk";
import type { QueryParams, QueryResult } from "../shared/handler-types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
  setSessionId,
  resetSession,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter, recordHistogram } from "../../util/metrics.js";
import { isTurnTerminator, stripMcpPrefix } from "../../core/tools/index.js";

import {
  createStreamState,
  recordToolUse,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  summarizeUsage,
  routeDelivery,
  buildDeliveryFailureReminder,
  TextBlockDeliveryError,
  applyRetryDecision,
  type StreamState,
} from "../shared/index.js";

import {
  CODEX_SYSTEM_PROMPT_SUFFIX,
  CODEX_DEFAULT_MODEL,
  CODEX_CHATGPT_DEFAULT_MODEL,
  CODEX_THREAD_PERMISSIONS,
} from "./constants.js";
import { getState } from "./state.js";
import { ensureCodex, getCodexAuthInfo } from "./init.js";
import { isChatGptModelMismatchError, isSilentOAuthExitError } from "./auth.js";
import {
  chatGptFallbackFor,
  getModelInfo,
  isCodexOAuthIncompat,
} from "./models.js";
import { supportsReasoningLevel } from "../../core/reasoning-levels.js";
import { markOAuthIncompat } from "./oauth-incompat.js";
import { classifyRateLimits, readLastRolloutSnapshot } from "./token-usage.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Error class for usage-exhausted Codex failures. Thrown when the
 * rollout JSONL positively indicates the account has no remaining
 * credits — retrying on a fallback model would just hit the same wall,
 * so we surface the cause clearly instead of looping.
 */
export class CodexUsageExhaustedError extends Error {
  constructor(
    public readonly modelTried: string,
    public readonly authMode: "chatgpt" | "api-key" | "none" | undefined,
  ) {
    const authNote =
      authMode === "chatgpt"
        ? " (free ChatGPT OAuth — credit window resets periodically; or " +
          "set TALON_CODEX_KEY / codexApiKey for billing-based access)"
        : authMode === "api-key"
          ? " (api-key tier — check billing or rate-limit window)"
          : "";
    super(`Codex usage exhausted while running ${modelTried}${authNote}`);
    this.name = "CodexUsageExhaustedError";
  }
}

/**
 * Probe the rollout JSONL for a usage-exhausted signal.
 *
 * Returns the snapshot's classification (`"exhausted" | "healthy" |
 * "unknown"`) plus the raw rate-limits payload for log enrichment.
 * Never throws — file IO errors degrade to `"unknown"`.
 *
 * Pulled out so both the silent-exit path and the explicit-mismatch
 * path can consult it (an explicit mismatch on an exhausted account is
 * possible; we'd rather surface "usage exhausted" than swap models in
 * that case too).
 */
async function probeUsageExhausted(
  threadId: string | undefined,
): Promise<
  | { classification: "exhausted"; limitId?: string; balance?: string }
  | { classification: "healthy" }
  | { classification: "unknown" }
> {
  if (!threadId) return { classification: "unknown" };
  let snap;
  try {
    snap = await readLastRolloutSnapshot(threadId);
  } catch {
    return { classification: "unknown" };
  }
  const rl = snap?.rateLimits;
  const cls = classifyRateLimits(rl);
  if (cls === "exhausted") {
    return {
      classification: "exhausted",
      limitId: rl?.limitId,
      balance: rl?.creditsBalance,
    };
  }
  return { classification: cls };
}

/**
 * One-shot ChatGPT-OAuth model-mismatch recovery.
 *
 * Three failure shapes are handled:
 *
 *   1. **Usage exhausted** (any auth mode) — when the rollout JSONL's
 *      latest `token_count.rate_limits` payload indicates `has_credits:
 *      false` or a populated `rate_limit_reached_type`, the failure
 *      isn't model-incompat at all — the account is out of budget.
 *      Throw `CodexUsageExhaustedError` so the caller surfaces the real
 *      cause; do NOT swap to a fallback model (it would hit the same
 *      wall). This is checked FIRST because both the explicit-mismatch
 *      and silent-exit paths can be triggered by exhausted accounts
 *      that happen to have ambiguous error text.
 *
 *   2. **Explicit mismatch** — Codex surfaced
 *      `"not supported when using Codex with a ChatGPT account"` via the
 *      JSON event stream or thrown error. This is the definitive
 *      OAuth-incompat signal and is persisted to the runtime-learned
 *      store.
 *
 *   3. **Silent exit-1 on OAuth** — the Codex CLI exited 1 without
 *      emitting the explicit text. This shape is genuinely ambiguous —
 *      observed causes include real OAuth-incompat models AND
 *      transient outages AND usage exhaustion. After the usage check
 *      rules out exhaustion, we treat it as a likely OAuth-incompat
 *      and retry on the OAuth flagship, but we do NOT persist it
 *      (would over-poison the learning store with transients).
 *
 *      Gating: ONLY fires when auth mode is `chatgpt` AND the active
 *      model isn't already the OAuth flagship — a silent exit on
 *      `gpt-5.5` means the credential itself is broken (retrying
 *      wouldn't help) or the account is in some other failure state.
 *
 * Returns a retry promise when explicit-mismatch or silent-exit
 * triggers AND we haven't already retried (`_retried` sentinel prevents
 * recursion). Returns `undefined` otherwise; the caller falls through
 * to its normal classify/throw path.
 *
 * The retry side-effects are confined here: session reset, fallback
 * model threaded through `params.model`, `_retried = true` on the
 * recursive call.
 */
async function maybeFallbackForChatGptMismatch(
  probeText: string,
  activeModel: string,
  params: QueryParams,
  retried: boolean,
  chatId: string,
  threadId?: string,
): Promise<QueryResult | undefined> {
  if (retried) return undefined;

  const explicit = isChatGptModelMismatchError(probeText);
  const authInfo = getCodexAuthInfo();
  const isOAuth = authInfo?.mode === "chatgpt";
  const silent =
    isOAuth &&
    activeModel !== CODEX_CHATGPT_DEFAULT_MODEL &&
    isSilentOAuthExitError(probeText);

  if (!explicit && !silent) return undefined;

  // Usage-exhausted check FIRST. If the rollout JSONL says the account
  // has no credits, both the explicit-mismatch and silent-exit shapes
  // are red herrings — the underlying cause is "no quota," and swapping
  // to a fallback model would burn another round-trip into the same
  // wall. Throw a clean error so the caller can surface the real
  // cause to the user. (This catches the 2026-05-21 17:39Z log Dylan
  // flagged: gpt-5.4-mini was reported as silent-exit oauth-incompat
  // when it was actually "premium tier credits exhausted, balance=0".)
  const usage = await probeUsageExhausted(threadId);
  if (usage.classification === "exhausted") {
    const detail =
      usage.limitId === "premium"
        ? "premium tier (free ChatGPT OAuth) exhausted"
        : usage.limitId
          ? `${usage.limitId} tier limit reached`
          : "no remaining credits";
    logWarn(
      "agent",
      `[${chatId}] Codex usage exhausted while running ${activeModel}: ` +
        `${detail}${usage.balance ? ` (balance=${usage.balance})` : ""}. ` +
        `NOT swapping to fallback — the same credential hits the same wall.`,
    );
    throw new CodexUsageExhaustedError(activeModel, authInfo?.mode);
  }

  const fallbackModel =
    chatGptFallbackFor(activeModel) ?? CODEX_CHATGPT_DEFAULT_MODEL;
  if (fallbackModel === activeModel) return undefined;

  // Only EXPLICIT mismatch errors are persisted as OAuth-incompat —
  // they're definitive ("not supported when using Codex with a ChatGPT
  // account" is an unambiguous server-side signal). Silent-exit
  // failures are ambiguous (could be model-incompat, transient
  // outage, brief rate-limit, or upstream blip) and would over-poison
  // the learning store if persisted. The silent path still triggers
  // an in-session retry below, just without the permanent record.
  if (isOAuth && explicit) {
    const recorded = await markOAuthIncompat(activeModel);
    if (recorded) {
      logWarn(
        "agent",
        `[${chatId}] Codex: recorded ${activeModel} as OAuth-incompat ` +
          `(explicit mismatch) — subsequent turns will skip pre-emptively`,
      );
    }
  }

  // Log wording is now honest about the heuristic: explicit mismatch
  // is a verdict, silent exit is a guess. Both retry on the fallback.
  const shape = explicit
    ? "explicit OAuth-incompat mismatch"
    : "silent exit on OAuth (heuristic: treating as possible OAuth-incompat)";
  logWarn(
    "agent",
    `[${chatId}] Codex ${shape} for ${activeModel}; ` +
      `resetting thread and retrying on ${fallbackModel}. ` +
      (isOAuth
        ? `Set TALON_CODEX_KEY or codexApiKey for billing-based access to api-key-only models.`
        : ``),
  );
  resetSession(chatId);
  return await handleMessage({ ...params, model: fallbackModel }, true);
}

// ── Active session registry ─────────────────────────────────────────────────

/** Tracks the in-flight abort controller per chat so cancellations can land. */
const activeAborts = new Map<string, AbortController>();

/** Get the in-flight abort controller for a chat, if a turn is running. */
export function getActiveAbort(chatId: string): AbortController | undefined {
  return activeAborts.get(chatId);
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const state = getState();
  const config = state.config;
  if (!config) {
    throw new Error("Codex agent not initialized");
  }
  const codex = ensureCodex(params.chatId);

  const {
    chatId,
    text,
    senderName,
    isGroup,
    messageId,
    onTextBlock,
    onToolUse,
  } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;

  // Resolve active model. Codex accepts arbitrary model strings; we
  // pass through whatever the chat settings hold. The fallback chain
  // is: chat-settings → config → auth-aware default. The auth-aware
  // default is `gpt-5-codex` when an API key is present, `gpt-5.5`
  // when only ChatGPT OAuth is configured (because `gpt-5-codex` is
  // rejected with a 400 on ChatGPT-mode accounts).
  const chatSettings = getChatSettings(chatId);
  const authInfo = getCodexAuthInfo();
  const authAwareDefault =
    authInfo?.mode === "chatgpt"
      ? CODEX_CHATGPT_DEFAULT_MODEL
      : CODEX_DEFAULT_MODEL;
  const requestedModel =
    params.model ?? chatSettings.model ?? config.model ?? authAwareDefault;
  // If the resolved model is known OAuth-incompat AND we're on
  // ChatGPT OAuth, pre-emptively swap to the chatgpt-compatible
  // fallback rather than letting the first turn fail. Two sources of
  // truth feed `isCodexOAuthIncompat`:
  //
  //   1. **Static** (`isCodexApiKeyOnlyModel`) — curated `apiKeyOnly`
  //      flag in `CODEX_MODELS`. Covers ids known at release time
  //      (`gpt-5-codex`).
  //
  //   2. **Dynamic** (`isKnownOAuthIncompat` via `oauth-incompat.ts`) —
  //      runtime-learned from observed silent-exit failures, persisted
  //      per-credential. Covers cache-discovered ids that the cache
  //      *claims* are `supported_in_api: true` but the CLI rejects on
  //      OAuth (e.g. `gpt-5.4-mini` — see Pandario 23:13Z 2026-05-20).
  //
  // The post-hoc recovery ladder in `maybeFallbackForChatGptMismatch`
  // would catch missed cases too, but pre-emptive saves the ~9s
  // round-trip every subsequent turn and makes the resolved-model log
  // line match what Codex actually sees.
  let activeModel = requestedModel;
  if (authInfo?.mode === "chatgpt" && isCodexOAuthIncompat(requestedModel)) {
    const fallback =
      chatGptFallbackFor(requestedModel) ?? CODEX_CHATGPT_DEFAULT_MODEL;
    // Guard against a learned-but-no-fallback case — only swap when the
    // fallback is actually different from what we'd already run.
    if (fallback !== requestedModel) {
      logWarn(
        "agent",
        `[${chatId}] Codex model ${requestedModel} is OAuth-incompat and ` +
          `current auth is ChatGPT OAuth — pre-emptively falling back to ${fallback}. ` +
          `Set TALON_CODEX_KEY / codexApiKey or change the configured model to silence this.`,
      );
      activeModel = fallback;
    }
  }
  log("agent", `[${chatId}] Codex model resolved: ${activeModel}`);

  // Per-session frozen prompt + Codex-specific delivery suffix.
  const { text: systemPrompt } = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: CODEX_SYSTEM_PROMPT_SUFFIX,
    chatId,
    sessionEpoch: session.createdAt,
  });

  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // Resume an existing Codex thread or start a fresh one. Codex
  // persists threads under `~/.codex/sessions/`; we store the thread
  // id in Talon's session storage so `resumeThread()` keeps the
  // conversation continuous across turns.
  //
  // ThreadOptions:
  //   - `skipGitRepoCheck` — Codex normally insists on running inside
  //     a git repo. We're an assistant, not a coding session.
  //   - Permission triple (`approvalPolicy` / `sandboxMode` /
  //     `networkAccessEnabled`) is centralised in
  //     `CODEX_THREAD_PERMISSIONS`; see that constant for the
  //     security-boundary reasoning. Tl;dr: Codex runs with the same
  //     full-access posture as every other Talon backend — restricting
  //     it tighter than its siblings just produces silent tool
  //     failures.
  const activeModelInfo = await getModelInfo(activeModel).catch(
    () => undefined,
  );
  const supportedReasoningLevels =
    activeModelInfo?.supportedReasoningLevels ?? [];
  const requestedEffort = chatSettings.effort;
  const modelReasoningEffort =
    requestedEffort &&
    requestedEffort !== "off" &&
    requestedEffort !== "max" &&
    supportsReasoningLevel(requestedEffort, supportedReasoningLevels)
      ? requestedEffort
      : undefined;
  const threadOptions = {
    model: activeModel,
    skipGitRepoCheck: true,
    ...(modelReasoningEffort
      ? {
          modelReasoningEffort: modelReasoningEffort as
            | "minimal"
            | "low"
            | "medium"
            | "high"
            | "xhigh",
        }
      : {}),
    ...CODEX_THREAD_PERMISSIONS,
  };
  const thread: Thread = session.sessionId
    ? codex.resumeThread(session.sessionId, threadOptions)
    : codex.startThread(threadOptions);

  const streamState = createStreamState();
  const seenToolCallIds = new Set<string>();
  const codexToolMetrics = { count: 0 };
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  let usage: Usage | null = null;
  let turnFailedError: string | undefined;
  let resolvedThreadId: string | undefined;

  const setupMs = Date.now() - t0;
  let turnMs = 0;

  try {
    const turnStart = Date.now();

    // Codex SDK supports passing a `system` prompt through the runtime
    // config. We thread it in via the `runStreamed` call so the agent
    // sees Talon's identity / memory / workspace listing.
    //
    // Note: Codex's SDK does not currently expose `system` directly on
    // `runStreamed`; system prompts are baked at thread creation via
    // the CLI's config. Talon-side workaround: prepend the system
    // prompt to the user prompt as a fenced "INSTRUCTIONS" block on
    // the first turn only. Subsequent turns inherit instructions from
    // the resumed thread.
    const inputText =
      previousTurns === 0 ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

    const { events } = await thread.runStreamed(inputText, {
      signal: abortController.signal,
    });

    for await (const event of events) {
      if (abortController.signal.aborted && !streamState.turnTerminated) break;
      handleEvent(event, {
        state: streamState,
        seenToolCallIds,
        codexToolMetrics,
        onTextBlock,
        onToolUse,
        chatId,
      });

      if (event.type === "thread.started") {
        resolvedThreadId = event.thread_id;
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        turnFailedError = event.error.message;
      } else if (event.type === "error") {
        turnFailedError = event.message;
      }

      // Terminator-driven abort: a delivery tool already shipped the
      // reply via the bridge. Cancel further model generation to skip
      // the wrap-up round-trip Codex would otherwise burn.
      if (streamState.turnTerminated && !abortController.signal.aborted) {
        log("agent", `[${chatId}] terminator fired — aborting Codex turn`);
        try {
          abortController.abort();
        } catch (err) {
          logWarn("agent", `[${chatId}] abort failed: ${errMsg(err)}`);
        }
      }
    }

    turnMs = Date.now() - turnStart;
  } catch (err) {
    // Aborted-by-terminator path is the expected close on `end_turn`.
    if (
      streamState.turnTerminated &&
      (errMsg(err) === "AbortError" || /abort/i.test(errMsg(err)))
    ) {
      // Swallow — turn completed via terminator tool.
    } else {
      // ChatGPT-OAuth model-mismatch path: a 400 invalid_request_error
      // saying "not supported when using Codex with a ChatGPT account".
      // Check both the captured event-stream message and the thrown
      // error — Codex SDK surfaces it via both channels.
      // Only use the thread ID from this run. Probing the previous
      // session can misclassify unrelated failures as usage exhaustion.
      const fallback = await maybeFallbackForChatGptMismatch(
        `${turnFailedError ?? ""} ${errMsg(err)}`,
        activeModel,
        params,
        _retried,
        chatId,
        resolvedThreadId,
      );
      if (fallback) return fallback;

      const outcome = await applyRetryDecision({
        err,
        chatId,
        activeModel,
        retried: _retried,
        params,
        recurseWithRetried: (p) => handleMessage(p, true),
        backendLabel: "Codex",
        resetNoun: "thread",
      });
      if (outcome.retry) return outcome.retry;

      logError(
        "agent",
        `[${chatId}] Codex error: ${outcome.classified.message}`,
      );
      throw outcome.classified;
    }
  } finally {
    if (activeAborts.get(chatId) === abortController) {
      activeAborts.delete(chatId);
    }
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  // Event-only ChatGPT-mismatch recovery: if the SDK emitted a
  // `turn.failed` carrying the mismatch text but DIDN'T rethrow, the
  // catch block above never fired. Catch it here too. (Current SDK
  // rethrows in this case, but this path defends against a future
  // change where it only surfaces via the event stream.)
  if (turnFailedError && !_retried) {
    const fallback = await maybeFallbackForChatGptMismatch(
      turnFailedError,
      activeModel,
      params,
      _retried,
      chatId,
    );
    if (fallback) return fallback;
  }

  if (resolvedThreadId) {
    const stored = getSession(chatId).sessionId;
    if (stored !== resolvedThreadId) {
      setSessionId(chatId, resolvedThreadId);
    }
  }

  if (usage) {
    recordTokens(streamState, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheRead: usage.cached_input_tokens,
      cacheWrite: 0, // Codex doesn't report cache writes
    });
  }

  // Codex's `turn.completed.usage` is CUMULATIVE across all API calls in
  // the turn, so it's useless as a "current context fill" signal — a
  // 20-call agentic turn easily reports 2M+ input tokens against a 272k
  // window. The Codex CLI writes a per-call `token_count` event into the
  // rollout JSONL with the LAST call's prompt size and the model's actual
  // context window. Read that here for an accurate /status display.
  // Falls back silently to "unknown" if the rollout file isn't available
  // (e.g. CODEX_HOME pointed elsewhere, permission issues, first run).
  if (resolvedThreadId) {
    const last = await readLastRolloutSnapshot(resolvedThreadId).catch(
      () => null,
    );
    if (last) {
      if (last.usage) {
        streamState.contextTokens = last.usage.contextTokens;
        if (last.usage.contextWindow) {
          streamState.contextWindow = last.usage.contextWindow;
        }
      }
      if (typeof last.numApiCalls === "number") {
        streamState.numApiCalls = last.numApiCalls;
      }
    }
  }

  // Surface a synthetic error if Codex failed the turn upstream.
  if (turnFailedError) {
    streamState.syntheticError = turnFailedError;
    incrementCounter("codex.turn_failed");
  }

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");
  incrementCounter("codex.turns_total");
  recordHistogram("codex.tool_calls_per_turn", codexToolMetrics.count);
  if (codexToolMetrics.count > 0) {
    incrementCounter("codex.turns_with_tools_total");
  }
  if (streamState.numApiCalls > 0) {
    incrementCounter("codex.api_calls_total", streamState.numApiCalls);
    recordHistogram("codex.api_calls_per_turn", streamState.numApiCalls);
  }

  recordUsage(chatId, {
    inputTokens: streamState.sdkInputTokens,
    outputTokens: streamState.sdkOutputTokens,
    cacheRead: streamState.sdkCacheRead,
    cacheWrite: streamState.sdkCacheWrite,
    durationMs,
    model: activeModel,
    // contextTokens comes from the rollout JSONL when available (the
    // SDK's cumulative usage is unsuitable — see comment above
    // `readLastTokenCount` call). Falls back to 0 → /status shows
    // "unknown", which is correct under-promise behaviour rather than
    // a wildly inflated number.
    contextTokens: streamState.contextTokens || undefined,
    // Prefer the rollout's reported context window (matches what the
    // model actually sees this turn) over the static catalog value.
    contextWindow: streamState.contextWindow ?? activeModelInfo?.contextWindow,
    numApiCalls: streamState.numApiCalls || undefined,
  });

  // Set a descriptive session name from the user's first message.
  if (previousTurns === 0) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Delivery ──────────────────────────────────────────────────────────────
  //
  // Decision tree shared with the other backends — see
  // `backend/shared/delivery.ts` for the full rationale.
  let delivery;
  try {
    delivery = await routeDelivery({
      backendLabel: "Codex",
      chatId,
      state: streamState,
      responseText,
      onTextBlock,
      propagateDeliveryFailure: true,
    });
  } catch (err) {
    if (err instanceof TextBlockDeliveryError && !_retried) {
      incrementCounter("delivery.text_block_retry");
      logWarn(
        "agent",
        `[${chatId}] ${err.message}; re-prompting Codex with delivery failure`,
      );
      return handleMessage(
        { ...params, text: buildDeliveryFailureReminder(err) },
        true,
      );
    }
    throw err;
  }

  incrementTurns(chatId);

  log(
    "agent",
    `[${chatId}] delivery: ${delivery.route} (${delivery.chars} chars)`,
  );

  log(
    "agent",
    `[${chatId}] -> (${summarizeUsage(
      {
        inputTokens: streamState.sdkInputTokens,
        outputTokens: streamState.sdkOutputTokens,
        cacheRead: streamState.sdkCacheRead,
        cacheWrite: streamState.sdkCacheWrite,
      },
      { durationMs, toolCalls: streamState.toolCalls },
    )} terminator=${streamState.turnTerminated ? "yes" : "no"} ` +
      `delivered=${streamState.deliveredTextNorms.length} ` +
      `respLen=${responseText.length} ` +
      `setup=${setupMs}ms turn=${turnMs}ms)`,
  );
  traceMessage(chatId, "out", responseText, {
    durationMs,
    toolCalls: streamState.toolCalls,
  });

  return {
    text: responseText,
    durationMs,
    inputTokens: streamState.sdkInputTokens,
    outputTokens: streamState.sdkOutputTokens,
    cacheRead: streamState.sdkCacheRead,
    cacheWrite: streamState.sdkCacheWrite,
  };
}

// ── Event handler ───────────────────────────────────────────────────────────

interface HandleEventContext {
  state: StreamState;
  seenToolCallIds: Set<string>;
  codexToolMetrics: { count: number };
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  chatId: string;
}

/**
 * Translate one Codex `ThreadEvent` into stream-state mutations.
 *
 * Synchronous — keeps the for-await loop simple. The shared
 * `routeDelivery` step at end-of-turn handles the final emit.
 */
function handleEvent(event: ThreadEvent, ctx: HandleEventContext): void {
  if (event.type !== "item.completed") return;
  handleItem(event.item, ctx);
}

function handleItem(item: ThreadItem, ctx: HandleEventContext): void {
  switch (item.type) {
    case "agent_message":
      handleAgentMessage(item, ctx);
      return;
    case "mcp_tool_call":
      handleMcpToolCall(item, ctx);
      return;
    case "command_execution":
      handleNativeCodexTool(ctx, "command_execution", {
        command: item.command,
        status: item.status,
        ...(typeof item.exit_code === "number"
          ? { exit_code: item.exit_code }
          : {}),
      });
      return;
    case "file_change":
      handleNativeCodexTool(ctx, "file_change", {
        status: item.status,
        changes: item.changes,
      });
      return;
    case "web_search":
      handleNativeCodexTool(ctx, "web_search", { query: item.query });
      return;
    case "reasoning":
    case "todo_list":
    case "error":
      // Reasoning is private scratchpad; todo_list is planning state.
      // Neither maps to Talon's reply or tool metrics. Error items get
      // logged below.
      if (item.type === "error") {
        logWarn("agent", `[${ctx.chatId}] Codex error item: ${item.message}`);
      }
      return;
    default: {
      const type =
        typeof (item as { type?: unknown }).type === "string"
          ? (item as { type: string }).type
          : "unknown";
      handleNativeCodexTool(ctx, type, nativeItemPayload(item));
      return;
    }
  }
}

function handleAgentMessage(
  item: AgentMessageItem,
  ctx: HandleEventContext,
): void {
  // agent_message is the model's final reply. Codex emits one per
  // turn with the complete text (no need to accumulate deltas — the
  // SDK has already coalesced them).
  if (typeof item.text === "string" && item.text.trim()) {
    ctx.state.allResponseText = item.text;
    ctx.state.lastTrailingText = item.text;
  }
}

function handleMcpToolCall(
  item: McpToolCallItem,
  ctx: HandleEventContext,
): void {
  // Only act on `completed`. Codex SDK emits each mcp_tool_call item
  // twice: once with `status: "in_progress"` when it dispatches the
  // tool to the MCP server, and again with `status: "completed"` after
  // the server returns the result. The earlier code accepted both —
  // combined with the `seenToolCallIds` dedup, that meant we acted on
  // whichever shape arrived first (in_progress, every time).
  //
  // For terminator tools (`end_turn` / `send` / `react`) this is a
  // race: marking `turnTerminated` on `in_progress` flips the abort
  // controller BEFORE the bridge call has had a chance to execute the
  // delivery. The abort kills the Codex subprocess (and with it the
  // MCP tool subprocess) mid-flight — if the bridge HTTP call hasn't
  // gone out yet, delivery never happens. Same shape as the Claude SDK
  // send/end_turn race that PR #122 fixed via PostToolBatch.
  //
  // Status `failed` is already filtered: skip it too. `in_progress` is
  // analytics-only on Codex — we record tool use at completion via the
  // same path, so dropping the in_progress emit costs nothing.
  if (item.status !== "completed") return;
  if (ctx.seenToolCallIds.has(item.id)) return;
  ctx.seenToolCallIds.add(item.id);

  // Codex names MCP tools as `<server>.<tool>` in the call item; the
  // shared `recordToolUse` / `isTurnTerminator` expect the bare tool
  // name (or `mcp__<server>__<tool>` form). Normalise via the upstream
  // tool name on the item.
  const toolName = item.tool;
  const input =
    item.arguments && typeof item.arguments === "object"
      ? (item.arguments as Record<string, unknown>)
      : {};

  const bareToolName = stripMcpPrefix(toolName);
  recordCodexToolMetric(ctx, bareToolName);
  recordToolUse(ctx.state, toolName, input);

  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch {
      /* non-fatal */
    }
  }

  if (!ctx.state.turnTerminated && isTurnTerminator(toolName, input)) {
    ctx.state.turnTerminated = true;
    log(
      "agent",
      `[Codex] terminator fired: ${describeToolCall(toolName, input)}`,
    );
  }
}

function recordCodexToolMetric(
  ctx: HandleEventContext,
  toolName: string,
): void {
  incrementCounter(`tool_calls.${toolName}`);
  incrementCounter("codex.tool_calls_total");
  incrementCounter(`codex.tool_calls.${toolName}`);
  ctx.codexToolMetrics.count += 1;
}

function handleNativeCodexTool(
  ctx: HandleEventContext,
  toolName: string,
  input: Record<string, unknown>,
): void {
  recordCodexToolMetric(ctx, toolName);
  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch {
      /* non-fatal */
    }
  }
}

function nativeItemPayload(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") {
    return {};
  }
  const { id: _id, type: _type, ...payload } = item as Record<string, unknown>;
  return payload;
}

/** One-line summary of a tool call for the operator log. */
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
