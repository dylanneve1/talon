/**
 * Main message handler — executes a user query through the Claude Agent SDK.
 *
 * Orchestrates the full lifecycle: prompt formatting, SDK query, stream
 * processing, error recovery (session expired / context overflow / model
 * fallback), token accounting, and session persistence.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionId,
  setSessionName,
} from "../../storage/sessions.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter, recordHistogram } from "../../util/metrics.js";
import { isTurnTerminator, stripMcpPrefix } from "../../core/tools/index.js";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { QueryParams, QueryResult } from "../../core/types.js";
import { getConfig } from "./state.js";
import { buildSdkOptions } from "./options.js";
import {
  createStreamState,
  isSystemInit,
  isStreamEvent,
  isAssistant,
  isResult,
  processStreamDelta,
  processAssistantMessage,
  processResultMessage,
} from "./stream.js";
import {
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  detectFlowViolation,
  FLOW_VIOLATION_MAX_RETRIES,
  captureDeliveredText,
  summarizeUsage,
  applyRetryDecision,
} from "../shared/index.js";

// ── Post-result watchdog ────────────────────────────────────────────────────
// The SDK's PostToolBatch hook is the canonical loop-terminator — it returns
// `{ continue: false }` after `end_turn`/`send`, and the SDK is supposed to
// emit a `result` SDKMessage and close the async iterator immediately after.
// In practice (observed 2026-05-19 14:52Z, chat 352042062, contextTokens=251464,
// numApiCalls=50) the SDK can emit `result` and then ghost — the for-await loop
// stays parked forever, holding the dispatcher context and the typing-indicator
// pulse for hours until someone manually `/restart`s.
//
// Workaround: arm a short timer the moment `result` is processed. If the
// iterator hasn't closed by the grace deadline, abort the controller and
// force-close the generator via `qi.return()`. The clean-exit case clears the
// timer in the same turn and pays nothing.

const DEFAULT_SDK_POST_RESULT_GRACE_MS = 5_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SDK_POST_RESULT_GRACE_MS = envMs(
  "TALON_SDK_POST_RESULT_GRACE_MS",
  DEFAULT_SDK_POST_RESULT_GRACE_MS,
);

// ── Active query store ──────────────────────────────────────────────────────
// Holds the Query reference for each in-flight chat so gateway actions
// (e.g. reload_plugins) can call control methods like setMcpServers().

const activeQueries = new Map<string, Query>();

/** Get the active Query for a chat, if one is in flight. */
export function getActiveQuery(chatId: string): Query | undefined {
  return activeQueries.get(chatId);
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _internal: { flowRetries?: number; errorRetried?: boolean } = {},
): Promise<QueryResult> {
  const config = getConfig();

  const {
    chatId,
    text,
    senderName,
    isGroup,
    onTextBlock,
    onStreamDelta,
    onToolUse,
  } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

  // Rebuild system prompt on first turn of a new/reset session so identity,
  // memory, and workspace listing are fresh. `prepareSystemPrompt` does
  // this in place (mutates config.systemPrompt) — the Claude SDK reads
  // from config.systemPrompt later via `buildSdkOptions`, so the rebuild
  // has to land before that call.
  prepareSystemPrompt({ config, previousTurns: session.turns });

  const abortController = new AbortController();
  const { options, activeModel } = buildSdkOptions(chatId, abortController);

  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId: params.messageId,
  });
  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  const qi = query({ prompt, options });
  activeQueries.set(chatId, qi);
  const state = createStreamState();

  // Post-result watchdog (see top-of-file). Armed inside the loop when the
  // first `result` message lands; disarmed in `finally` either way.
  let postResultTimer: ReturnType<typeof setTimeout> | null = null;
  let postResultForceClosed = false;
  const armPostResultWatchdog = (): void => {
    if (postResultTimer) return;
    const t = setTimeout(() => {
      postResultForceClosed = true;
      logWarn(
        "agent",
        `[${chatId}] SDK iterator stuck ${SDK_POST_RESULT_GRACE_MS}ms after result — aborting`,
      );
      incrementCounter("sdk.iterator_force_close_after_result");
      try {
        abortController.abort();
      } catch {
        /* abort() can throw if already aborted — ignore */
      }
      // `qi.return()` resolves the async generator with `{ done: true }`,
      // exiting the for-await loop without throwing. Combined with abort()
      // above, the SDK subprocess gets torn down AND our loop releases.
      qi.return(undefined).catch(() => {
        /* the generator may already be in a terminal state — ignore */
      });
    }, SDK_POST_RESULT_GRACE_MS);
    t.unref();
    postResultTimer = t;
  };

  // Capture text args from delivery tools (`end_turn`, `send(type="text")`)
  // so the end-of-turn trailing-text fallback can dedupe against content
  // already delivered. Without this, a model that writes prose AND calls a
  // delivery tool with similar text would surface twice in the chat.
  //
  // Tool names arrive MCP-prefixed (e.g. `mcp__telegram-tools__end_turn`)
  // when routed through MCP — strip the prefix so equality checks match
  // the registry's bare names.
  // `captureDeliveredText` (from shared/) returns the normalized text
  // norm — push it into state for the post-turn dedup check.
  const captureIntoState = (
    toolName: string,
    input: Record<string, unknown>,
  ): void => {
    const norm = captureDeliveredText(toolName, input);
    if (norm) state.deliveredTextNorms.push(norm);
  };

  try {
    for await (const message of qi) {
      // Session ID capture
      if (isSystemInit(message)) {
        state.newSessionId = message.session_id;
        continue;
      }

      // Stream text deltas and thinking deltas
      if (isStreamEvent(message)) {
        processStreamDelta(message, state, onStreamDelta);
        continue;
      }

      // Complete assistant message — extract text blocks and tool calls
      if (isAssistant(message)) {
        const result = processAssistantMessage(message, state);

        // Track the trailing text from this assistant message. Multiple
        // assistant messages can fire per turn (one per tool-use round-trip);
        // only the LAST one's trailingText is the user-facing final reply.
        state.lastTrailingText = result.trailingText;

        // Notify tool usage + capture delivery-tool text for end-of-turn dedup
        for (const tool of result.tools) {
          incrementCounter(`tool_calls.${stripMcpPrefix(tool.name)}`);
          captureIntoState(tool.name, tool.input);
          // Pass tool.input so the soft-terminator opt-out (e.g. react
          // with `end_turn: false`) keeps state.turnTerminated correctly
          // false — otherwise the trailing-text dedup path mis-treats a
          // mid-turn react as the final delivery.
          if (isTurnTerminator(tool.name, tool.input)) {
            state.turnTerminated = true;
          }
          if (onToolUse) {
            try {
              onToolUse(tool.name, tool.input);
            } catch (err) {
              logWarn(
                "agent",
                `onToolUse callback threw for ${tool.name}: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }

        // Send progress text segments (text before each tool call) in order
        if (onTextBlock) {
          for (const text of result.progressTexts) {
            try {
              await onTextBlock(text);
            } catch {
              /* non-fatal — don't abort the stream loop */
            }
          }
        }

        // Turn-terminator detection happens here (sets `state.turnTerminated`
        // for the flow-violation check below) but the actual SDK loop exit
        // is owned by the `PostToolBatch` hook in `options.ts`. The hook
        // fires after every tool in the batch has resolved, returns
        // `{ continue: false }`, and the SDK exits with TerminalReason
        // `'hook_stopped'` — no extra "wrap up after end_turn" round-trip,
        // no phantom typing, no token spend on a stop_turn.
        //
        // Historical note: an earlier implementation called `qi.interrupt()`
        // here directly. That raced with in-flight MCP tool dispatches in
        // the same assistant message — `end_turn` itself is an MCP tool,
        // and the model frequently emits sibling tool_use blocks alongside
        // it. `interrupt()` cancelled their AbortController mid-flight,
        // surfacing as `MCP error -32001: AbortError` and bubbling up as
        // "Something went wrong". The `PostToolBatch` hook avoids the race
        // by definition (it fires once the entire batch has resolved).
        continue;
      }

      // Final result — read token counts and context info
      if (isResult(message)) {
        processResultMessage(message, state, options.model ?? activeModel);
        // Arm the watchdog the moment we see `result`. On a clean SDK exit
        // the iterator closes within milliseconds and the timer never fires;
        // on a hang the timer aborts the controller and force-closes the
        // generator after the grace window.
        armPostResultWatchdog();
      }
    }
  } catch (err) {
    // Our own watchdog force-closed the iterator after the SDK stalled
    // post-result. The work is already done — the result message was
    // processed, the response was delivered via the delivery tool, and
    // `state` is fully populated. Treat the abort as a clean exit so the
    // post-loop code runs and frees the dispatcher lock.
    if (!postResultForceClosed) {
      const outcome = await applyRetryDecision({
        err,
        chatId,
        activeModel,
        retried: _internal.errorRetried ?? false,
        params,
        recurseWithRetried: (p) =>
          handleMessage(p, {
            ..._internal,
            errorRetried: true,
          }),
        // No backendLabel — historical claude-sdk log shape was un-prefixed
        // (just `[chatId] session_expired, resetting…`). Preserving that.
      });
      if (outcome.retry) return outcome.retry;

      logError("agent", `[${chatId}] SDK error: ${outcome.classified.message}`);
      throw outcome.classified;
    }
  } finally {
    if (postResultTimer) {
      clearTimeout(postResultTimer);
      postResultTimer = null;
    }
    if (activeQueries.get(chatId) === qi) {
      activeQueries.delete(chatId);
    }
  }

  // ── Persist session and usage ─────────────────────────────────────────────

  const durationMs = Date.now() - t0;
  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");
  if (state.newSessionId) setSessionId(chatId, state.newSessionId);
  // Token usage is recorded for THIS attempt unconditionally — the running
  // session totals are additive, so a flow-violation retry that recurses
  // through this same path will record its own tokens on top. The turn
  // counter, in contrast, must only increment ONCE per user message (see
  // the post-violation block below).
  recordUsage(chatId, {
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    durationMs,
    model: activeModel,
    contextTokens: state.contextTokens,
    contextWindow: state.contextWindow,
    numApiCalls: state.numApiCalls,
  });

  // Set a descriptive session name from the first message
  if (session.turns === 0 && text) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Trailing-prose contract + flow-violation retry ──────────────────────
  // The output stream is private scratchpad by design. Final replies must go
  // through `end_turn` (canonical) or `send` (mid-turn rich content). The
  // shared `detectFlowViolation` decides whether trailing prose constitutes
  // a missed delivery (and whether to re-prompt the model once with the
  // synthetic reminder).
  //
  // `incrementTurns` is deferred until AFTER this check so the retry path
  // (which recurses through `handleMessage` and hits its own
  // `incrementTurns` at the end of that call) doesn't double-count a
  // single user message as two turns.
  const violation = detectFlowViolation({
    trailingText: state.lastTrailingText,
    turnTerminated: state.turnTerminated,
    deliveredTextNorms: state.deliveredTextNorms,
    toolCalls: state.toolCalls,
    retried: (_internal.flowRetries ?? 0) > 0,
    retryCount: _internal.flowRetries ?? 0,
    maxRetries: FLOW_VIOLATION_MAX_RETRIES,
  });

  if (violation.violated) {
    incrementCounter("scratchpad.trailing_text_dropped");
    log(
      "agent",
      `[${chatId}] flow violation: ${violation.reason}. ${
        violation.shouldRetry
          ? "Re-prompting with reminder."
          : `Retry cap (${FLOW_VIOLATION_MAX_RETRIES}) exhausted — accepting silent drop.`
      }`,
    );

    if (violation.shouldRetry) {
      incrementCounter("scratchpad.flow_violation_retried");
      // The recursive call owns the `incrementTurns` for this user message.
      // We deliberately don't increment here.
      return handleMessage(
        { ...params, text: violation.reminder },
        {
          ..._internal,
          flowRetries: (_internal.flowRetries ?? 0) + 1,
        },
      );
    }
    incrementCounter("scratchpad.flow_violation_cap_exhausted");
  }

  // Reached the non-retry path — this turn counts as one user-visible turn.
  incrementTurns(chatId);

  // ── Build result ──────────────────────────────────────────────────────────

  state.allResponseText += state.currentBlockText;

  log(
    "agent",
    `[${chatId}] -> (${summarizeUsage(
      {
        inputTokens: state.sdkInputTokens,
        outputTokens: state.sdkOutputTokens,
        cacheRead: state.sdkCacheRead,
        cacheWrite: state.sdkCacheWrite,
      },
      { durationMs, toolCalls: state.toolCalls },
    )})`,
  );
  traceMessage(chatId, "out", state.allResponseText, {
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    toolCalls: state.toolCalls,
    model: activeModel,
  });

  return {
    text: state.allResponseText.trim(),
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
  };
}
