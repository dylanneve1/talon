/**
 * Claude SDK chat-turn handler — natively emits `AgentEvent`s.
 *
 * Owns the SDK-specific half of a turn: the options build, the `query()`
 * subprocess, the per-message event translation, error recovery
 * (session expired / context overflow / model fallback via
 * `applyRetryDecisionStream`) and the post-result watchdog. The phases
 * after the stream — accounting, the trailing-prose contract, the result
 * events — are the shared ones in `backend/shared/turn-phases.ts`.
 *
 * The exported async generator `runChatTurn` is what the factory wires
 * onto `ChatBackend.runChatTurn` — no wrapper, no callback shim.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  getSession,
  incrementTurns,
  updateLiveTurn,
} from "../../storage/sessions.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter } from "../../storage/metrics.js";
import { isTurnTerminator } from "../../core/tools/index.js";

import type {
  Query,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
import { invalidatePlanUsage } from "./plan-usage.js";
import { frontendsForChat } from "../shared/frontends.js";
import {
  createStreamState,
  isSystemInit,
  isStreamEvent,
  isAssistant,
  isResult,
  isRateLimitEvent,
  isUserMessage,
  extractToolResults,
  processStreamDelta,
  processAssistantMessage,
  processResultMessage,
  type StreamState,
} from "./stream.js";
import {
  formatUserPrompt,
  prepareSystemPrompt,
  captureDeliveredText,
  summarizeUsage,
  buildDeliveryContract,
  buildFlowViolationReminder,
  buildFirstTurnReminder,
  recordToolCall,
  formatTurnCache,
  crossTurnVerdict,
  priorLookbackOverflow,
  noteLookbackRisk,
  CACHE_LOOKBACK_BLOCKS,
  accountTurn,
  accountFailedTurn,
  nameSessionFromFirstMessage,
  enforceTrailingProse,
  buildResultEvents,
  turnUsageSnapshot,
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

type PostResultWatchdog = {
  /** Start the grace timer once `result` is processed (idempotent). */
  arm(): void;
  clear(): void;
  /** True once the timer fired and force-closed the iterator. */
  readonly forceClosed: boolean;
};

function createPostResultWatchdog(
  chatId: string,
  abortController: AbortController,
  qi: Query,
): PostResultWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let forceClosed = false;
  return {
    get forceClosed() {
      return forceClosed;
    },
    arm() {
      if (timer) return;
      const t = setTimeout(() => {
        forceClosed = true;
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
      timer = t;
    },
    clear() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
    },
  };
}

// ── Active query store ──────────────────────────────────────────────────────
// Holds the Query reference for each in-flight chat so gateway actions
// (e.g. reload_plugins) can call control methods like setMcpServers().

const activeQueries = new Map<string, Query>();

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

/** Get the active Query for a chat, if one is in flight. */
export function getActiveQuery(chatId: string): Query | undefined {
  return activeQueries.get(chatId);
}

// ── Internal state passed across recursive retry calls ──────────────────────

type InternalState = { flowRetries?: number; errorRetried?: boolean };

// ── Stream translation ──────────────────────────────────────────────────────

/**
 * Per-API-call usage accumulator for live mid-turn stats. Each assistant
 * message carries its API call's usage as it lands; the authoritative
 * per-turn totals still come from the final result message
 * (`processResultMessage`) — this only feeds the live-turn overlay so
 * /status moves while a long agentic turn runs, and the failure path so
 * an errored turn's burn isn't lost.
 */
type LiveUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
};

function noteAssistantUsage(
  chatId: string,
  state: StreamState,
  live: LiveUsage,
  message: SDKAssistantMessage,
): void {
  const u = message.message.usage;
  if (!u) return;
  live.input += u.input_tokens ?? 0;
  live.output += u.output_tokens ?? 0;
  live.cacheRead += u.cache_read_input_tokens ?? 0;
  live.cacheWrite += u.cache_creation_input_tokens ?? 0;
  live.calls += 1;
  updateLiveTurn(chatId, {
    inputTokens: live.input,
    outputTokens: live.output,
    cacheRead: live.cacheRead,
    cacheWrite: live.cacheWrite,
    // This call's full prompt = current context fill.
    contextTokens:
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
    contextWindow: state.contextWindow ?? 0,
    numApiCalls: live.calls,
  });
}

type StreamContext = {
  chatId: string;
  qi: Query;
  state: StreamState;
  live: LiveUsage;
  watchdog: PostResultWatchdog;
  /** Model the result message's usage is attributed to. */
  model: string;
  /** tool_use id → tool name for calls announced this turn. */
  pendingTools: Map<string, string>;
};

/**
 * Translate one assistant message: progress text segments BEFORE the tool
 * calls they precede, so a model that says "let me check…" then calls a
 * tool delivers the explanatory text first.
 */
function* translateAssistantMessage(
  ctx: StreamContext,
  message: SDKAssistantMessage,
): Generator<AgentEvent, void, void> {
  const { chatId, state } = ctx;
  const result = processAssistantMessage(message, state);
  state.lastTrailingText = result.trailingText;
  noteAssistantUsage(chatId, state, ctx.live, message);

  for (const progress of result.progressTexts) {
    yield { type: "assistant_message", text: progress };
  }

  for (const tool of result.tools) {
    recordToolCall(chatId, tool.name, "claude");
    const norm = captureDeliveredText(tool.name, tool.input);
    if (norm) state.deliveredTextNorms.push(norm);
    if (isTurnTerminator(tool.name, tool.input)) {
      state.turnTerminated = true;
    }
    // Use the SDK's tool_use block id so the later tool_result (same id)
    // correlates — a UI spinner opened on this event can only be closed
    // by an event carrying the same id.
    const toolId =
      tool.id ||
      `${tool.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ctx.pendingTools.set(toolId, tool.name);
    yield { type: "tool_call", id: toolId, name: tool.name, input: tool.input };
  }
}

/**
 * Tool executions come back as tool_result blocks on synthetic user
 * messages. Emit the matching tool_result event — the other half of the
 * lifecycle a tool_call opens (frontends show a spinner until it arrives).
 */
function* translateToolResults(
  ctx: StreamContext,
  message: SDKUserMessage,
): Generator<AgentEvent, void, void> {
  for (const tr of extractToolResults(message)) {
    const name = ctx.pendingTools.get(tr.toolUseId);
    if (!name) continue; // not a tool we announced (subagent, replay)
    ctx.pendingTools.delete(tr.toolUseId);
    yield {
      type: "tool_result",
      id: tr.toolUseId,
      name,
      ...(tr.error ? { error: tr.error } : {}),
    };
  }
}

/** The `for await` over the SDK's message stream, one event type at a time. */
async function* consumeSdkStream(
  ctx: StreamContext,
): AsyncGenerator<AgentEvent, void, void> {
  const { state } = ctx;
  for await (const message of ctx.qi) {
    if (isSystemInit(message)) {
      state.newSessionId = message.session_id;
      continue;
    }
    if (isStreamEvent(message)) {
      const emit = processStreamDelta(message, state);
      if (emit) {
        yield emit.phase === "text"
          ? { type: "text_delta", text: emit.text }
          : { type: "reasoning", text: emit.text };
      }
      continue;
    }
    if (isAssistant(message)) {
      yield* translateAssistantMessage(ctx, message);
      continue;
    }
    if (isUserMessage(message)) {
      yield* translateToolResults(ctx, message);
      continue;
    }
    // The turn just moved the plan's usage — drop the cached windows so
    // the next /status reads them again instead of showing pre-turn
    // figures.
    if (isRateLimitEvent(message)) {
      invalidatePlanUsage();
      continue;
    }
    if (isResult(message)) {
      processResultMessage(message, state, ctx.model);
      ctx.watchdog.arm();
    }
  }
}

// ── Turn-local helpers ──────────────────────────────────────────────────────

function createLiveUsage(): LiveUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
}

/**
 * The recursive retry stream for `applyRetryDecisionStream`. A fallback
 * model id is threaded through the retry's params (`params.model`
 * outranks chat settings, so a transient `setChatModel` flip would be a
 * silent no-op).
 */
function retryStreamBuilder(
  params: ChatRunParams,
  internal: InternalState,
): (fallbackModelId?: string) => AsyncIterable<AgentEvent> {
  return (fallbackModelId) =>
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
      { ...internal, errorRetried: true },
    );
}

/**
 * First turn of a session is where flow violations cluster — the model
 * hasn't seen the contract in action yet. One line appended to the turn-0
 * user message (never the system prompt, so the cached prefix is
 * untouched) pre-empts the 2x-token violation retry. Skipped on flow
 * retries: those already carry the full reminder.
 */
function buildTurnPrompt(
  params: ChatRunParams,
  frontend: string | undefined,
  previousTurns: number,
  internal: InternalState,
): string {
  let prompt = formatUserPrompt({
    text: params.text,
    senderName: params.senderName ?? "user",
    senderHandle: params.senderHandle,
    isGroup: params.isGroup,
    messageId: params.messageId,
    retrievedMemory: params.retrievedMemory,
  });
  if (frontend && previousTurns === 0 && !internal.flowRetries) {
    prompt += `\n\n${buildFirstTurnReminder(frontend)}`;
  }
  return prompt;
}

/**
 * Terminal failure — account for whatever the turn consumed before dying
 * (failed turns burn real tokens). The result message never arrived, so
 * `state.sdk*` is usually empty; fall back to the per-call accumulator.
 */
function accountFailedClaudeTurn(
  chatId: string,
  state: StreamState,
  live: LiveUsage,
  model: string,
  durationMs: number,
): void {
  const sawResultUsage =
    state.sdkInputTokens +
      state.sdkOutputTokens +
      state.sdkCacheRead +
      state.sdkCacheWrite >
    0;
  accountFailedTurn({
    backend: "claude",
    chatId,
    state,
    durationMs,
    model,
    apiCalls: state.numApiCalls || live.calls,
    usage: sawResultUsage
      ? turnUsageSnapshot(state)
      : {
          inputTokens: live.input,
          outputTokens: live.output,
          cacheRead: live.cacheRead,
          cacheWrite: live.cacheWrite,
        },
  });
}

/**
 * The aggregate `cache=NN%` can't distinguish a turn that reused the
 * previous turn's prefix from one that re-wrote it — see
 * shared/cache-telemetry.ts. A lookback overflow only *predicts* a miss,
 * so warn when this turn's verdict proves the previous turn's overflow
 * cost a prefix re-write, then record this turn's overflow for the next.
 */
function reportCacheVerdict(chatId: string, state: StreamState): void {
  if (state.cacheStats) {
    const overflow = priorLookbackOverflow(chatId);
    if (
      overflow !== undefined &&
      crossTurnVerdict(state.cacheStats) === "miss"
    ) {
      logWarn(
        "agent",
        `[${chatId}] previous turn emitted ~${overflow} content blocks ` +
          `(> ${CACHE_LOOKBACK_BLOCKS} lookback) and this turn's prefix ` +
          `missed — that turn's cache write was likely never read`,
      );
    }
  }
  noteLookbackRisk(chatId, state.toolCalls);
}

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
  const { chatId, text } = params;
  const session = getSession(chatId);
  const t0 = Date.now();

  // The chat's OWNING messaging frontend (falling back to the primary for
  // cross-surface chats). Drives the delivery-contract suffix and the
  // frontend-aware flow-violation text — the tool NAMES differ per
  // frontend, and with tool servers scoped per chat the wrong contract
  // would instruct a tool that doesn't exist. Empty in terminal mode,
  // where no delivery tools exist and the strict tool-only contract must
  // not be asserted.
  const frontend: string | undefined = frontendsForChat(
    chatId,
    getActiveFrontends(),
  )[0];

  // Frozen per-session prompt (keyed by session epoch) — stable across
  // turns so the provider's prompt-cache prefix survives other chats'
  // session resets. The delivery contract joins as the backend suffix —
  // the tail of the static prompt, the highest-salience spot.
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
  const prompt = buildTurnPrompt(params, frontend, session.turns, _internal);
  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, {
    senderName: params.senderName,
    isGroup: params.isGroup,
  });

  yield { type: "run_started" };

  const qi = query({ prompt, options });
  activeQueries.set(chatId, qi);

  // Cold-start delivery-tool race: on the FIRST turn of a freshly-opened
  // chat the hub's `${frontend}-tools` binding can still be `pending` when
  // the model builds its tool list, so `end_turn`/`send` are absent and the
  // reply silently fails. Wait (bounded, non-throwing) for it to connect;
  // returns immediately on warm turns. Mirrors the `refreshTools` gate.
  if (frontend) {
    await waitForMcpServersReady(qi, [`${frontend}-tools`], 5_000, 100);
  }

  const state = createStreamState();
  const live = createLiveUsage();
  const watchdog = createPostResultWatchdog(chatId, abortController, qi);

  let propagateError: AgentEvent | null = null;
  try {
    yield* consumeSdkStream({
      chatId,
      qi,
      state,
      live,
      watchdog,
      model: options.model ?? activeModel,
      pendingTools: new Map(),
    });
    // The SDK doesn't throw on API errors — it converts them into a
    // synthetic assistant message and finishes the turn with an error-
    // flagged result (usage limits, 429s, auth failures all land here).
    // Rethrow so this turn takes the SAME path as a thrown SDK error
    // instead of tripping the flow-violation re-prompt loop against an
    // already-exhausted limit.
    if (state.resultErrorText) {
      throw new Error(state.resultErrorText);
    }
  } catch (err) {
    if (!watchdog.forceClosed) {
      const { retried, classified } = yield* applyRetryDecisionStream({
        err,
        chatId,
        activeModel,
        retried: _internal.errorRetried ?? false,
        buildRetryStream: retryStreamBuilder(params, _internal),
        // No backendLabel — historical claude-sdk log shape was un-prefixed.
      });
      // The recursive stream already yielded its own usage + completed.
      if (retried) return;
      logError("agent", `[${chatId}] SDK error: ${classified.message}`);
      // Defer the yield until after `finally` releases the watchdog timer
      // and the activeQueries entry.
      propagateError = {
        type: "error",
        error: classifiedToAgentError(classified),
      };
    }
  } finally {
    watchdog.clear();
    if (activeQueries.get(chatId) === qi) {
      activeQueries.delete(chatId);
    }
  }

  if (propagateError) {
    accountFailedClaudeTurn(chatId, state, live, activeModel, Date.now() - t0);
    yield propagateError;
    return;
  }

  const durationMs = Date.now() - t0;
  accountTurn({
    chatId,
    backend: "claude",
    state,
    durationMs,
    model: activeModel,
    sessionId: state.newSessionId,
    context: {
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
      numApiCalls: state.numApiCalls,
      costUsd: state.costUsd,
    },
  });
  nameSessionFromFirstMessage({
    chatId,
    text,
    previousTurns: session.turns,
    isRetry: Boolean(_internal.flowRetries),
  });

  // Only messaging frontends have a tool-only delivery contract to enforce.
  // In terminal mode (`frontend` undefined) there are no delivery tools and
  // trailing prose IS the reply (the terminal renderer surfaces it via
  // `result.text`); running the check there would re-prompt the model to
  // call `end_turn`, a tool that mode doesn't even register.
  const flowRetries = _internal.flowRetries ?? 0;
  const violation = frontend
    ? enforceTrailingProse({
        chatId,
        state,
        flowRetries,
        reminder: buildFlowViolationReminder(frontend),
      })
    : undefined;
  if (violation?.violated && violation.shouldRetry) {
    yield* runChatTurn(
      { ...params, text: violation.reminder },
      { ..._internal, flowRetries: flowRetries + 1 },
    );
    return;
  }

  // Reached the non-retry path — this turn counts as one user-visible turn.
  incrementTurns(chatId);

  state.allResponseText += state.currentBlockText;
  reportCacheVerdict(chatId, state);

  const usage = turnUsageSnapshot(state);
  log(
    "agent",
    `[${chatId}] -> (${summarizeUsage(usage, {
      durationMs,
      toolCalls: state.toolCalls,
      ...(state.cacheStats
        ? { suffix: formatTurnCache(state.cacheStats) }
        : {}),
    })})`,
  );
  traceMessage(chatId, "out", state.allResponseText, {
    durationMs,
    ...usage,
    toolCalls: state.toolCalls,
    model: activeModel,
  });
  yield* buildResultEvents({
    text: state.allResponseText.trim(),
    durationMs,
    usage,
    modelId: activeModel,
  });
}
