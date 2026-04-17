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
  resetSession,
  setSessionId,
  setSessionName,
} from "../../storage/sessions.js";
import { getChatSettings, setChatModel } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { getFallbackModel } from "../../core/models.js";
import { rebuildSystemPrompt } from "../../util/config.js";
import { getPluginPromptAdditions } from "../../core/plugin.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter, recordHistogram } from "../../util/metrics.js";
import { formatFullDatetime } from "../../util/time.js";

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
  _retried = false,
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
  // memory, and workspace listing are fresh
  if (session.turns === 0) {
    rebuildSystemPrompt(config, getPluginPromptAdditions());
  }

  const { options, activeModel } = buildSdkOptions(chatId);

  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const nowTag = `[${formatFullDatetime()}]`;

  const prompt = isGroup
    ? `${nowTag} [${senderName}]${msgIdHint}: ${text}`
    : `${nowTag}${msgIdHint} ${text}`;
  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  const qi = query({ prompt, options });
  activeQueries.set(chatId, qi);
  const state = createStreamState();

  // ── Progress watchdog ──────────────────────────────────────────────────
  // The handler is "making progress" whenever it consumes an SDK message. If
  // that stretches past WATCHDOG_MS, something is stuck — MCP subprocess
  // died, network stall, model API wedge, or (more commonly) a long await
  // inside our own onTextBlock/onToolUse callbacks. Either way we want to
  // abort rather than leave the typing spinner running forever.
  //
  // The watchdog is a Promise<never> that rejects on timeout. It's raced
  // against the iteration Promise so a hang aborts the handler even if
  // qi.interrupt() fails to unstick the SDK iterator. `interrupt()` is
  // still called best-effort as a cleanup signal.
  //
  // Note: bumpActivity() fires on every consumed SDK message. If the handler
  // itself blocks inside `await onTextBlock(text)` (e.g. Telegram send
  // stalls), the SDK may have more output buffered that we're simply not
  // reading — so the "stall" the watchdog detects is the *handler's*, not
  // necessarily the SDK's. That's still the right thing to abort.
  const WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes of stalled progress
  const WATCHDOG_CHECK_MS = 30_000; // check every 30s
  let lastActivityAt = Date.now();
  let resultReceived = false;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogCancelled = false;
  const bumpActivity = (): void => {
    lastActivityAt = Date.now();
  };
  const cancelWatchdog = (): void => {
    watchdogCancelled = true;
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };

  const watchdogPromise = new Promise<never>((_, reject) => {
    const check = (): void => {
      if (watchdogCancelled) return;
      const silent = Date.now() - lastActivityAt;
      if (silent > WATCHDOG_MS) {
        const silentSec = Math.round(silent / 1000);
        logWarn(
          "agent",
          `[${chatId}] Watchdog: handler stalled for ${silentSec}s — aborting`,
        );
        incrementCounter("agent.watchdog_fired");
        // Best-effort: signal the SDK to unwind cleanly. If it doesn't
        // respond the Promise.race below will still reject via this path.
        qi.interrupt().catch((err: unknown) => {
          logWarn(
            "agent",
            `[${chatId}] Watchdog interrupt() failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        // Report the actual measured silence — it can exceed WATCHDOG_MS by
        // up to WATCHDOG_CHECK_MS (or more under event-loop pressure), so
        // the message is more useful than a hardcoded threshold.
        reject(
          new Error(
            `Query timed out after ${silentSec}s without progress (likely a stuck tool call)`,
          ),
        );
        return;
      }
      watchdogTimer = setTimeout(check, WATCHDOG_CHECK_MS);
    };
    watchdogTimer = setTimeout(check, WATCHDOG_CHECK_MS);
  });
  // Prevent an unhandled rejection if the happy path resolves first and
  // cancelWatchdog() stops the timer without us awaiting watchdogPromise.
  watchdogPromise.catch(() => {});

  const iterateStream = async (): Promise<void> => {
    for await (const message of qi) {
      bumpActivity();
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

        // Notify tool usage
        for (const tool of result.tools) {
          incrementCounter(`tool_calls.${tool.name}`);
          if (onToolUse) {
            try {
              onToolUse(tool.name, tool.input);
            } catch {
              /* non-fatal */
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
            // Bump in case the send took a long time — it's progress from
            // the user's perspective even if no SDK message arrived.
            bumpActivity();
          }
        }
        continue;
      }

      // Final result — read token counts and context info
      if (isResult(message)) {
        resultReceived = true;
        processResultMessage(message, state, options.model ?? activeModel);
      }
    }
  };

  // Capture the iterator promise separately so we can drain the loser of
  // the race. Promise.race doesn't cancel the loser; if the watchdog wins
  // and we don't drain the iterator, a later rejection (e.g. SDK throws
  // after interrupt()) surfaces as an unhandled rejection, and any
  // subprocess the SDK is still holding would leak until the handler
  // returns. The drain is bounded by a short grace period so a truly
  // stuck SDK can't hold the handler indefinitely.
  const iterPromise = iterateStream();
  // Silence "possibly unhandled" — the race below handles the real outcome.
  iterPromise.catch(() => {});

  try {
    await Promise.race([iterPromise, watchdogPromise]);
  } catch (err) {
    const classified = classify(err);
    incrementCounter(`errors.${classified.reason ?? "unknown"}`);

    // Session expired — reset and retry once
    if (classified.reason === "session_expired" && !_retried) {
      logWarn(
        "agent",
        `[${chatId}] Stale session, retrying with fresh session`,
      );
      resetSession(chatId);
      return handleMessage(params, true);
    }

    // Context length exceeded — safety net for edge cases where SDK
    // auto-compaction doesn't prevent overflow
    if (classified.reason === "context_length" && !_retried) {
      logWarn(
        "agent",
        `[${chatId}] Context length exceeded, resetting session and retrying`,
      );
      resetSession(chatId);
      return handleMessage(params, true);
    }

    // Model fallback: if overloaded/timeout, retry with the configured fallback
    if (!_retried && classified.retryable) {
      const fallback = getFallbackModel(activeModel);
      if (fallback) {
        logWarn(
          "agent",
          `[${chatId}] ${classified.reason}, falling back to ${fallback}`,
        );
        resetSession(chatId);
        const originalModel = getChatSettings(chatId).model;
        setChatModel(chatId, fallback);
        try {
          return await handleMessage(params, true);
        } finally {
          setChatModel(chatId, originalModel);
        }
      }
    }

    logError("agent", `[${chatId}] SDK error: ${classified.message}`);
    throw classified;
  } finally {
    cancelWatchdog();
    // If the watchdog won the race (or any other throw happened before
    // iterPromise settled), give the SDK iterator up to 2s to unwind so
    // it doesn't leak pending work after we've already thrown. We swallow
    // errors here — the race has already reported the real outcome.
    await Promise.race([
      iterPromise.catch(() => {}),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    if (activeQueries.get(chatId) === qi) {
      activeQueries.delete(chatId);
    }
  }

  // Defensive: if we're here, Promise.race resolved via iterateStream
  // (the watchdog path always rejects and flows through the catch above),
  // but we never saw a `result` message. That means the SDK iterator
  // exited between turns without emitting a terminal result — unlikely in
  // practice but worth surfacing so a silent no-op can't masquerade as
  // a successful turn.
  if (!resultReceived) {
    incrementCounter("errors.no_result");
    const msg = "SDK stream ended without a result message";
    logError("agent", `[${chatId}] ${msg}`);
    throw new Error(msg);
  }

  // ── Persist session and usage ─────────────────────────────────────────────

  const durationMs = Date.now() - t0;
  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");
  if (state.newSessionId) setSessionId(chatId, state.newSessionId);
  incrementTurns(chatId);
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
    const cleanText = text
      .replace(/^\[.*?\]\s*/g, "")
      .replace(/\[msg_id:\d+\]\s*/g, "")
      .trim();
    if (cleanText) {
      const name =
        cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText;
      setSessionName(chatId, name);
    }
  }

  // ── Build result ──────────────────────────────────────────────────────────

  state.allResponseText += state.currentBlockText;
  const totalPrompt =
    state.sdkInputTokens + state.sdkCacheRead + state.sdkCacheWrite;
  const cacheHitPct =
    totalPrompt > 0 ? Math.round((state.sdkCacheRead / totalPrompt) * 100) : 0;

  log(
    "agent",
    `[${chatId}] -> (${durationMs}ms, in=${state.sdkInputTokens} out=${state.sdkOutputTokens} cache=${cacheHitPct}%` +
      `${state.toolCalls > 0 ? ` tools=${state.toolCalls}` : ""})`,
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
