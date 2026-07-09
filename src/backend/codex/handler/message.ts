/**
 * Codex main message handler.
 *
 * Orchestrates the full turn lifecycle on top of `@openai/codex-sdk`'s
 * `Thread.runStreamed`. Shares the non-SDK-specific primitives with the other
 * backends via `../../shared/`. Codex-specific bits: reading the `runStreamed`
 * event stream, translating items into shared stream state (see `events.ts`),
 * resuming via `codex.resumeThread(id)`, the rollout-JSONL live/settle usage
 * accounting, and the ChatGPT-OAuth model-mismatch recovery ladder.
 */

import type { Thread, Usage } from "@openai/codex-sdk";
import type { QueryParams, QueryResult } from "../../shared/handler-types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
  setSessionId,
  resetSession,
} from "../../../storage/sessions.js";
import { getChatSettings } from "../../../storage/chat-settings.js";
import { log, logError, logWarn } from "../../../util/log.js";
import { traceMessage } from "../../../util/trace.js";
import { incrementCounter } from "../../../util/metrics.js";

import {
  createStreamState,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  formatPromptWithRetrievedMemory,
  prepareSystemPrompt,
  extractSessionName,
  summarizeUsage,
  routeDelivery,
  buildDeliveryFailureReminder,
  TextBlockDeliveryError,
  applyRetryDecision,
  recordTurnMetrics,
  recordFailedTurnAccounting,
  pushLiveUsage,
} from "../../shared/index.js";

import {
  codexSystemPromptSuffix,
  CODEX_DEFAULT_MODEL,
  CODEX_CHATGPT_DEFAULT_MODEL,
  CODEX_THREAD_PERMISSIONS,
  CODEX_LIVE_POLL_INTERVAL_MS,
} from "../constants.js";
import {
  frontendsForChat,
  nonTerminalFrontends,
} from "../../shared/frontends.js";
import { getState } from "../state.js";
import { ensureCodex, getCodexAuthInfo } from "../init.js";
import {
  isChatGptModelMismatchError,
  isSilentOAuthExitError,
} from "../auth.js";
import {
  chatGptFallbackFor,
  getModelInfo,
  isCodexOAuthIncompat,
} from "../models.js";
import { supportsReasoningLevel } from "../../../core/models/reasoning-levels.js";
import { markOAuthIncompat } from "../oauth-incompat.js";
import { readLastRolloutSnapshot } from "../token-usage.js";
import { activeAborts } from "./state.js";
import { CodexUsageExhaustedError, probeUsageExhausted } from "./usage.js";
import { handleEvent } from "./events.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

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
 *      wall). Checked FIRST because both the explicit-mismatch and
 *      silent-exit paths can be triggered by exhausted accounts.
 *
 *   2. **Explicit mismatch** — Codex surfaced
 *      `"not supported when using Codex with a ChatGPT account"`. This is
 *      the definitive OAuth-incompat signal and is persisted.
 *
 *   3. **Silent exit-1 on OAuth** — the Codex CLI exited 1 without the
 *      explicit text. Ambiguous; after the usage check rules out
 *      exhaustion, treat it as likely OAuth-incompat and retry on the
 *      OAuth flagship, but do NOT persist it. Gating: only fires when
 *      auth mode is `chatgpt` AND the active model isn't already the
 *      OAuth flagship.
 *
 * Returns a retry promise when explicit-mismatch or silent-exit triggers
 * AND we haven't already retried (`_retried` sentinel prevents recursion).
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
  // wall. Throw a clean error so the caller can surface the real cause.
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
  // they're definitive. Silent-exit failures are ambiguous and would
  // over-poison the learning store if persisted. The silent path still
  // triggers an in-session retry below, just without the permanent record.
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

  // Log wording is honest about the heuristic: explicit mismatch is a
  // verdict, silent exit is a guess. Both retry on the fallback.
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
  // fallback rather than letting the first turn fail.
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
    backendSuffix: codexSystemPromptSuffix(
      frontendsForChat(chatId, nonTerminalFrontends(config.frontend))[0] ??
        "telegram",
    ),
    chatId,
    sessionEpoch: session.createdAt,
  });

  // Retrieved memory wraps the FORMATTED live prompt (Phase B): it stays
  // outside the frozen system prompt, so the first-turn concatenation below
  // keeps the boundary "cached systemPrompt, separator, live prompt wrapper".
  const prompt = formatPromptWithRetrievedMemory(
    formatUserPrompt({
      text,
      senderName: senderName ?? "user",
      isGroup,
      messageId,
    }),
    params.retrievedMemory,
  );

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  // Resume an existing Codex thread or start a fresh one. Codex persists
  // threads under `~/.codex/sessions/`; we store the thread id in Talon's
  // session storage so `resumeThread()` keeps the conversation continuous.
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
            "minimal" | "low" | "medium" | "high" | "xhigh",
        }
      : {}),
    ...CODEX_THREAD_PERMISSIONS,
  };
  const thread: Thread = session.sessionId
    ? codex.resumeThread(session.sessionId, threadOptions)
    : codex.startThread(threadOptions);

  // Baseline cumulative token totals from the rollout JSONL, captured
  // BEFORE the turn runs. `total_token_usage` accumulates across the
  // whole session file, so this turn's usage = post-turn totals minus
  // this baseline. Fresh threads have no rollout yet → zero baseline.
  // `null` = resumed thread whose baseline couldn't be read.
  const baselineTotals = session.sessionId
    ? ((await readLastRolloutSnapshot(session.sessionId).catch(() => null))
        ?.totals ?? null)
    : { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };

  // Bind the stream state to the chat so token mutators mirror counts
  // into the live-turn overlay — /status updates while the turn runs.
  const streamState = createStreamState(chatId);
  const seenToolCallIds = new Set<string>();
  const codexToolMetrics = { count: 0 };
  const abortController = new AbortController();
  activeAborts.set(chatId, abortController);

  let usage: Usage | null = null;
  let turnFailedError: string | undefined;
  let resolvedThreadId: string | undefined;

  // Throttled mid-turn rollout poll. The Codex CLI appends a
  // `token_count` event to the rollout JSONL after every API call, so
  // tailing it during the turn gives live context-fill / token / API-call
  // stats long before `turn.completed`. Fire-and-forget with an in-flight
  // guard — never blocks the event loop, never throws.
  let rolloutPollInFlight = false;
  let lastRolloutPollAt = 0;
  const pollRolloutForLiveStats = () => {
    if (!resolvedThreadId || rolloutPollInFlight) return;
    const now = Date.now();
    if (now - lastRolloutPollAt < CODEX_LIVE_POLL_INTERVAL_MS) return;
    rolloutPollInFlight = true;
    lastRolloutPollAt = now;
    readLastRolloutSnapshot(resolvedThreadId)
      .then((snap) => {
        if (!snap) return;
        if (snap.usage) {
          streamState.contextTokens = snap.usage.contextTokens;
          if (snap.usage.contextWindow) {
            streamState.contextWindow = snap.usage.contextWindow;
          }
        }
        if (typeof snap.numApiCalls === "number") {
          streamState.numApiCalls = snap.numApiCalls;
        }
        // Same delta-vs-baseline math as the post-loop accounting; the
        // final pass recomputes and overwrites, so a torn mid-turn read
        // can't corrupt the committed numbers.
        if (snap.totals && baselineTotals) {
          streamState.sdkInputTokens = Math.max(
            0,
            snap.totals.inputTokens - baselineTotals.inputTokens,
          );
          streamState.sdkOutputTokens = Math.max(
            0,
            snap.totals.outputTokens - baselineTotals.outputTokens,
          );
          streamState.sdkCacheRead = Math.max(
            0,
            snap.totals.cachedInputTokens - baselineTotals.cachedInputTokens,
          );
        }
        pushLiveUsage(streamState);
      })
      .catch(() => {})
      .finally(() => {
        rolloutPollInFlight = false;
      });
  };

  // Final authoritative usage settlement — shared by the success post-loop
  // and the terminal-failure path so failed turns account for the tokens
  // they burned too. Codex's `turn.completed.usage` is CUMULATIVE, so we
  // read the per-call `token_count` event from the rollout JSONL for an
  // accurate /status display, falling back silently when unavailable.
  const settleUsageAccounting = async (): Promise<void> => {
    if (usage) {
      recordTokens(streamState, {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheRead: usage.cached_input_tokens,
        cacheWrite: 0, // Codex doesn't report cache writes
      });
    }
    if (!resolvedThreadId) return;
    const last = await readLastRolloutSnapshot(resolvedThreadId).catch(
      () => null,
    );
    if (!last) return;
    if (last.usage) {
      streamState.contextTokens = last.usage.contextTokens;
      if (last.usage.contextWindow) {
        streamState.contextWindow = last.usage.contextWindow;
      }
    }
    if (typeof last.numApiCalls === "number") {
      streamState.numApiCalls = last.numApiCalls;
    }
    // Terminator-driven turns abort the stream before `turn.completed`
    // fires, so the SDK-side `usage` capture above is null on almost
    // every Talon turn. Recover this turn's real usage by diffing the
    // rollout's cumulative totals against the pre-turn baseline.
    if (!usage && last.totals && baselineTotals) {
      recordTokens(streamState, {
        inputTokens: last.totals.inputTokens - baselineTotals.inputTokens,
        outputTokens: last.totals.outputTokens - baselineTotals.outputTokens,
        cacheRead:
          last.totals.cachedInputTokens - baselineTotals.cachedInputTokens,
        cacheWrite: 0, // Codex doesn't report cache writes
      });
    }
  };

  const setupMs = Date.now() - t0;
  let turnMs = 0;

  try {
    const turnStart = Date.now();

    // Codex's SDK does not expose `system` directly on `runStreamed`;
    // system prompts are baked at thread creation via the CLI's config.
    // Talon-side workaround: prepend the system prompt to the user prompt
    // as a fenced block on the first turn only. Subsequent turns inherit
    // instructions from the resumed thread.
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

      pollRolloutForLiveStats();

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
      // ChatGPT-OAuth model-mismatch path. Check both the captured
      // event-stream message and the thrown error — Codex SDK surfaces
      // it via both channels. Only use the thread ID from this run.
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

      // Terminal failure — recover whatever usage the rollout recorded
      // before the turn died, then account for it (failed turns burn
      // real tokens; they must not vanish from /status and /metrics).
      await settleUsageAccounting().catch(() => {});
      recordFailedTurnAccounting({
        backend: "codex",
        chatId,
        durationMs: Date.now() - t0,
        toolCalls: codexToolMetrics.count,
        apiCalls: streamState.numApiCalls,
        model: activeModel,
        usage: {
          inputTokens: streamState.sdkInputTokens,
          outputTokens: streamState.sdkOutputTokens,
          cacheRead: streamState.sdkCacheRead,
          cacheWrite: streamState.sdkCacheWrite,
        },
        contextTokens: streamState.contextTokens,
        contextWindow: streamState.contextWindow,
      });

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
  // catch block above never fired. Catch it here too.
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

  await settleUsageAccounting();

  // Surface a synthetic error if Codex failed the turn upstream.
  if (turnFailedError) {
    streamState.syntheticError = turnFailedError;
  }

  const responseText = finalizeResponseText(streamState);
  const durationMs = Date.now() - t0;
  recordTurnMetrics({
    chatId,
    backend: "codex",
    durationMs,
    toolCalls: codexToolMetrics.count,
    apiCalls: streamState.numApiCalls,
    failed: Boolean(turnFailedError),
    usage: {
      inputTokens: streamState.sdkInputTokens,
      outputTokens: streamState.sdkOutputTokens,
      cacheRead: streamState.sdkCacheRead,
      cacheWrite: streamState.sdkCacheWrite,
    },
  });

  recordUsage(chatId, {
    inputTokens: streamState.sdkInputTokens,
    outputTokens: streamState.sdkOutputTokens,
    cacheRead: streamState.sdkCacheRead,
    cacheWrite: streamState.sdkCacheWrite,
    durationMs,
    model: activeModel,
    // contextTokens comes from the rollout JSONL when available. Falls
    // back to 0 → /status shows "unknown", correct under-promise behaviour.
    contextTokens: streamState.contextTokens || undefined,
    // Prefer the rollout's reported context window over the static catalog.
    contextWindow: streamState.contextWindow ?? activeModelInfo?.contextWindow,
    numApiCalls: streamState.numApiCalls || undefined,
  });

  // Set a descriptive session name from the user's first message.
  if (previousTurns === 0) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Delivery — decision tree shared with the other backends ────────────────
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
