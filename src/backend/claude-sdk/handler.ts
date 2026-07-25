/**
 * Claude SDK chat-turn handler — natively emits `AgentEvent`s.
 *
 * Drives the full lifecycle: prompt formatting, SDK query, native
 * event emission per stream message, error recovery (session expired
 * / context overflow / model fallback via `applyRetryDecisionStream`),
 * token accounting, session persistence, and the flow-violation
 * re-prompt loop.
 *
 * The exported async generator `runChatTurn` is what the factory wires
 * onto `ChatBackend.runChatTurn` — no wrapper, no callback shim.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionId,
  setSessionName,
  updateLiveTurn,
} from "../../storage/sessions.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter } from "../../storage/metrics.js";
import { isTurnTerminator } from "../../core/tools/index.js";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  type AgentEvent,
  classifiedToAgentError,
} from "../../core/agent-runtime/events.js";
import type { ChatRunParams } from "../../core/agent-runtime/capabilities.js";
import { makeBareModelRef } from "../../core/agent-runtime/model-ref.js";
import { applyRetryDecisionStream } from "../shared/handle-retry.js";
import { getConfig } from "./state.js";
import { buildSdkOptions, getActiveFrontends } from "./options.js";
import { waitForMcpServersReady } from "./mcp-ready.js";
import { frontendsForChat } from "../shared/frontends.js";
import {
  createStreamState,
  isSystemInit,
  isStreamEvent,
  isAssistant,
  isResult,
  isUserMessage,
  extractToolResults,
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
  buildDeliveryContract,
  buildFlowViolationReminder,
  buildFirstTurnReminder,
  recordToolCall,
  recordTurnMetrics,
  recordFailedTurnAccounting,
  recordFlowViolation,
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
/**
 * Best-effort graceful interrupt of a chat's in-flight turn. Uses the SDK's
 * native `Query.interrupt()`, which stops the agent loop and closes the stream
 * with a `result` (subtype `interrupt`) — so the turn ends as a normal
 * completion (turn_end + usage), NOT an error, and never trips the
 * model-fallback retry path. No-op (returns false) when no turn is running.
 */
export async function interruptChatTurn(chatId: string): Promise<boolean> {
  const qi = activeQueries.get(chatId);
  if (!qi) return false;
  try {
    await qi.interrupt();
    log("agent", `[${chatId}] turn interrupted by user`);
    incrementCounter("sdk.turn_interrupted");
    return true;
  } catch (err) {
    logWarn(
      "agent",
      `[${chatId}] interrupt failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

export function getActiveQuery(chatId: string): Query | undefined {
  return activeQueries.get(chatId);
}

// ── Internal state passed across recursive retry calls ──────────────────────

type InternalState = { flowRetries?: number; errorRetried?: boolean };

// ── Main chat-turn generator ────────────────────────────────────────────────

/**
 * Native chat-turn generator. Yields the canonical
 * `run_started → text_delta* → reasoning* → assistant_message* →
 * tool_call* → usage → completed` sequence. On error: emits an
 * `error` event (after running the shared retry decision, which may
 * recurse via `yield*` and produce the retry's event stream
 * transparently). On flow violation: `yield* runChatTurn(retry
 * params)` — the recursive call owns its `incrementTurns`, the
 * caller deliberately doesn't increment.
 */
export async function* runChatTurn(
  params: ChatRunParams,
  _internal: InternalState = {},
): AsyncIterable<AgentEvent> {
  const config = getConfig();

  const { chatId, text, senderName, isGroup } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

  // The chat's OWNING messaging frontend (falling back to the primary
  // for cross-surface chats). Drives the delivery-contract suffix and
  // the frontend-aware flow-violation text — the tool NAMES differ per
  // frontend (native's send tool is send_message, telegram's is send),
  // and with tool servers scoped per chat the wrong contract would
  // instruct a tool that doesn't exist. Empty in terminal mode, where
  // no delivery tools exist and the strict tool-only contract must not
  // be asserted.
  const frontend: string | undefined = frontendsForChat(
    chatId,
    getActiveFrontends(),
  )[0];

  // Frozen per-session prompt (keyed by session epoch) — stable across
  // turns so the provider's prompt-cache prefix survives other chats'
  // session resets. See backend/shared/system-prompt.ts. The delivery
  // contract joins as the backend suffix — the tail of the static
  // prompt, the highest-salience spot — so models see the tool-only
  // flow before their first turn instead of discovering it via a
  // [FLOW VIOLATION] retry.
  const preparedPrompt = prepareSystemPrompt({
    config,
    previousTurns: session.turns,
    chatId,
    sessionEpoch: session.createdAt,
    backendSuffix: frontend
      ? buildDeliveryContract("tool-only", frontend)
      : undefined,
  });

  const abortController = new AbortController();
  const { options, activeModel } = buildSdkOptions(
    chatId,
    abortController,
    params.model.id,
    preparedPrompt,
  );

  let prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId: params.messageId,
  });
  // First turn of a session is where flow violations cluster — the
  // model hasn't seen the contract in action yet. One line appended to
  // the turn-0 user message (never the system prompt, so the cached
  // prefix is untouched) pre-empts the 2x-token violation retry.
  // Skipped on flow retries: those already carry the full reminder.
  if (frontend && session.turns === 0 && !_internal.flowRetries) {
    prompt += `\n\n${buildFirstTurnReminder(frontend)}`;
  }
  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  yield { type: "run_started" };

  const qi = query({ prompt, options });
  activeQueries.set(chatId, qi);

  // Cold-start delivery-tool race. The Claude SDK spawns a fresh subprocess
  // per turn, and each reconnects to the hub's `${frontend}-tools` server.
  // `alwaysLoad` is meant to block startup until that server connects, but on
  // the FIRST turn of a freshly-opened chat the hub binding is created cold and
  // can still be `pending` when the model builds its turn-1 tool list — so
  // `end_turn`/`send` are absent and the reply silently fails (or the model
  // burns a `tool_search` round-trip to recover it). After a close+reconnect
  // the hub binding is warm, connects instantly, and the tools are present —
  // which is exactly why the bug "heals" on reconnect. Explicitly wait (bounded,
  // non-throwing) for the delivery server to leave `pending` before consuming
  // the stream. This mirrors the proven `refreshTools` gate and returns
  // immediately on warm turns, so it adds no steady-state latency.
  if (frontend) {
    await waitForMcpServersReady(qi, [`${frontend}-tools`], 5_000, 100);
  }

  const state = createStreamState();
  // tool_use id → tool name for calls we've announced this turn; lets
  // the tool_result emission name the tool without re-parsing blocks.
  const pendingTools = new Map<string, string>();

  // Per-API-call usage accumulator for live mid-turn stats. Each
  // assistant message carries its API call's usage as it lands; the
  // authoritative per-turn totals still come from the final result
  // message (processResultMessage) — this only feeds the live-turn
  // overlay so /status moves while a long agentic turn runs, and the
  // failure path below so an errored turn's burn isn't lost.
  const liveAcc = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    calls: 0,
  };

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
      qi.return(undefined).catch(() => {
        /* the generator may already be in a terminal state — ignore */
      });
    }, SDK_POST_RESULT_GRACE_MS);
    t.unref();
    postResultTimer = t;
  };

  const captureIntoState = (
    toolName: string,
    input: Record<string, unknown>,
  ): void => {
    const norm = captureDeliveredText(toolName, input);
    if (norm) state.deliveredTextNorms.push(norm);
  };

  let propagateError: AgentEvent | null = null;
  try {
    for await (const message of qi) {
      if (isSystemInit(message)) {
        state.newSessionId = message.session_id;
        continue;
      }

      if (isStreamEvent(message)) {
        const emit = processStreamDelta(message, state);
        if (emit) {
          if (emit.phase === "text") {
            yield { type: "text_delta", text: emit.text };
          } else {
            yield { type: "reasoning", text: emit.text };
          }
        }
        continue;
      }

      if (isAssistant(message)) {
        const result = processAssistantMessage(message, state);
        state.lastTrailingText = result.trailingText;

        const u = message.message.usage;
        if (u) {
          liveAcc.input += u.input_tokens ?? 0;
          liveAcc.output += u.output_tokens ?? 0;
          liveAcc.cacheRead += u.cache_read_input_tokens ?? 0;
          liveAcc.cacheWrite += u.cache_creation_input_tokens ?? 0;
          liveAcc.calls += 1;
          updateLiveTurn(chatId, {
            inputTokens: liveAcc.input,
            outputTokens: liveAcc.output,
            cacheRead: liveAcc.cacheRead,
            cacheWrite: liveAcc.cacheWrite,
            // This call's full prompt = current context fill.
            contextTokens:
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0),
            contextWindow: state.contextWindow ?? 0,
            numApiCalls: liveAcc.calls,
          });
        }

        // Emit progress text segments BEFORE the tool calls they
        // precede, so a model that says "let me check…" then calls a
        // tool delivers the explanatory text first.
        for (const progress of result.progressTexts) {
          yield { type: "assistant_message", text: progress };
        }

        for (const tool of result.tools) {
          recordToolCall(chatId, tool.name, "claude");
          captureIntoState(tool.name, tool.input);
          if (isTurnTerminator(tool.name, tool.input)) {
            state.turnTerminated = true;
          }
          // Use the SDK's tool_use block id so the later tool_result
          // (same id) correlates — a UI spinner opened on this event
          // can only be closed by an event carrying the same id.
          const toolId =
            tool.id ||
            `${tool.name}-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`;
          pendingTools.set(toolId, tool.name);
          yield {
            type: "tool_call",
            id: toolId,
            name: tool.name,
            input: tool.input,
          };
        }
        continue;
      }

      // Tool executions come back as tool_result blocks on synthetic
      // user messages. Emit the matching tool_result event — the other
      // half of the lifecycle a tool_call opens (frontends show a
      // spinner until it arrives).
      if (isUserMessage(message)) {
        for (const tr of extractToolResults(message)) {
          const name = pendingTools.get(tr.toolUseId);
          if (!name) continue; // not a tool we announced (subagent, replay)
          pendingTools.delete(tr.toolUseId);
          yield {
            type: "tool_result",
            id: tr.toolUseId,
            name,
            ...(tr.error ? { error: tr.error } : {}),
          };
        }
        continue;
      }

      if (isResult(message)) {
        processResultMessage(message, state, options.model ?? activeModel);
        armPostResultWatchdog();
      }
    }

    // The SDK doesn't throw on API errors — it converts them into a
    // synthetic assistant message and finishes the turn with an error-
    // flagged result (usage limits, 429s, auth failures all land here).
    // Rethrow the captured error text so this turn takes the SAME path
    // as a thrown SDK error: retry decision, failed-turn accounting, and
    // an `error` event carrying the real message — instead of being
    // treated as a normal reply (which, with no delivery tool call,
    // would trip the flow-violation re-prompt loop and burn more turns
    // against an already-exhausted limit).
    if (state.resultErrorText) {
      throw new Error(state.resultErrorText);
    }
  } catch (err) {
    if (!postResultForceClosed) {
      const buildRetryStream = (
        fallbackModelId?: string,
      ): AsyncIterable<AgentEvent> =>
        runChatTurn(
          fallbackModelId
            ? {
                ...params,
                model: makeBareModelRef(
                  params.model.backend,
                  fallbackModelId,
                  "fallback",
                ),
              }
            : params,
          { ..._internal, errorRetried: true },
        );
      const { retried, classified } = yield* applyRetryDecisionStream({
        err,
        chatId,
        activeModel,
        retried: _internal.errorRetried ?? false,
        buildRetryStream,
        // No backendLabel — historical claude-sdk log shape was un-prefixed.
      });
      if (retried) {
        // The recursive stream already yielded its own usage + completed.
        return;
      }
      logError("agent", `[${chatId}] SDK error: ${classified.message}`);
      // Defer the actual yield until after the `finally` cleanup runs so the
      // watchdog timer and activeQueries entry are released first.
      propagateError = {
        type: "error",
        error: classifiedToAgentError(classified),
      };
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

  if (propagateError) {
    // Terminal failure — account for whatever the turn consumed before
    // dying (failed turns burn real tokens). The result message never
    // arrived, so state.sdk* is usually empty; fall back to the per-call
    // accumulator. Retried turns return earlier and never reach here.
    const sawResultUsage =
      state.sdkInputTokens +
        state.sdkOutputTokens +
        state.sdkCacheRead +
        state.sdkCacheWrite >
      0;
    recordFailedTurnAccounting({
      backend: "claude",
      chatId,
      durationMs: Date.now() - t0,
      toolCalls: state.toolCalls,
      apiCalls: state.numApiCalls || liveAcc.calls,
      model: activeModel,
      usage: sawResultUsage
        ? {
            inputTokens: state.sdkInputTokens,
            outputTokens: state.sdkOutputTokens,
            cacheRead: state.sdkCacheRead,
            cacheWrite: state.sdkCacheWrite,
          }
        : {
            inputTokens: liveAcc.input,
            outputTokens: liveAcc.output,
            cacheRead: liveAcc.cacheRead,
            cacheWrite: liveAcc.cacheWrite,
          },
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
    });
    yield propagateError;
    return;
  }

  // ── Persist session and usage ─────────────────────────────────────────────

  const durationMs = Date.now() - t0;
  recordTurnMetrics({
    chatId,
    backend: "claude",
    durationMs,
    toolCalls: state.toolCalls,
    apiCalls: state.numApiCalls,
    usage: {
      inputTokens: state.sdkInputTokens,
      outputTokens: state.sdkOutputTokens,
      cacheRead: state.sdkCacheRead,
      cacheWrite: state.sdkCacheWrite,
    },
  });
  if (state.newSessionId) setSessionId(chatId, state.newSessionId);
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

  // Set a descriptive session name from the first message.
  // Guard against flow-violation retries, which pass the reminder text as
  // `text` — we only want the original user message, not the synthetic prompt.
  if (session.turns === 0 && text && !_internal.flowRetries) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Trailing-prose contract + flow-violation retry ──────────────────────

  // Only messaging frontends have a tool-only delivery contract to enforce.
  // In terminal mode (`frontend` undefined) there are no delivery tools and
  // trailing prose IS the reply — the terminal renderer surfaces it via
  // `result.text` when nothing came through the bridge (see
  // frontend/terminal/index.ts). Running the check there would flag the
  // model's natural prose as a violation and re-prompt it to call `end_turn`,
  // a tool that mode doesn't even register. Mirrors the `frontend`-gated
  // delivery-contract suffix above.
  const violation = frontend
    ? detectFlowViolation({
        trailingText: state.lastTrailingText,
        turnTerminated: state.turnTerminated,
        deliveredTextNorms: state.deliveredTextNorms,
        toolCalls: state.toolCalls,
        retried: (_internal.flowRetries ?? 0) > 0,
        retryCount: _internal.flowRetries ?? 0,
        maxRetries: FLOW_VIOLATION_MAX_RETRIES,
        reminder: buildFlowViolationReminder(frontend),
      })
    : ({ violated: false } as const);

  if (violation.violated) {
    recordFlowViolation(
      chatId,
      violation.shouldRetry ? "retried" : "cap_exhausted",
    );
    log(
      "agent",
      `[${chatId}] flow violation: ${violation.reason}. ${
        violation.shouldRetry
          ? "Re-prompting with reminder."
          : `Retry cap (${FLOW_VIOLATION_MAX_RETRIES}) exhausted — accepting silent drop.`
      }`,
    );

    if (violation.shouldRetry) {
      yield* runChatTurn(
        { ...params, text: violation.reminder },
        {
          ..._internal,
          flowRetries: (_internal.flowRetries ?? 0) + 1,
        },
      );
      return;
    }
  }

  // Reached the non-retry path — this turn counts as one user-visible turn.
  incrementTurns(chatId);

  // ── Build result events ──────────────────────────────────────────────────

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

  const usage = {
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    modelId: activeModel,
  };
  yield { type: "usage", usage };
  yield {
    type: "completed",
    result: {
      text: state.allResponseText.trim(),
      durationMs,
      usage,
      modelId: activeModel,
    },
  };
}
