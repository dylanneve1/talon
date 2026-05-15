/**
 * Kilo main message handler.
 *
 * Orchestrates the full turn lifecycle on top of Kilo's HTTP API + SSE
 * event stream. Behaviour mirrors `claude-sdk/handler.ts` and shares its
 * non-SDK-specific primitives via `../shared/`:
 *
 *   - Stream state accumulator (text, tool calls, trailing prose, etc.)
 *   - Tool-use detection + turn-terminator handling (end_turn / send / react)
 *   - Progress-text emission before each tool call
 *   - Flow-violation re-prompt for prose without delivery tool
 *   - Model fallback on rate-limit / overload / network
 *   - Context-overflow + session-expiry recovery
 *   - First-turn system-prompt rebuild + plugin prompt additions
 *   - `[YYYY-MM-DD HH:MM:SS] [Name] [msg_id:N]` prompt formatting
 *
 * What's Kilo-specific (lives here, not in shared):
 *
 *   - Reading events from Kilo's SSE stream (`global.event()`).
 *   - Translating Kilo's `ToolPart` lifecycle into shared mutators.
 *   - Calling `session.abort()` to terminate on `end_turn`.
 *   - Provider lookup against Kilo's `/provider/list` endpoint.
 */

import type { KiloClient } from "@kilocode/sdk/v2";
import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionName,
  resetSession,
} from "../../storage/sessions.js";
import { getChatSettings, setChatModel } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";
import { incrementCounter, recordHistogram } from "../../util/metrics.js";

import {
  ensureServer,
  ensureSession,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  resolveProviderID,
  parseStoredKiloModelSelection,
  getConfig,
  KILO_SYSTEM_PROMPT_SUFFIX,
  errMsg,
} from "./server.js";
import {
  extractPartsSummary,
  extractAssistantUsage,
  getKiloTurnSummary,
  waitForAssistantReply,
  rejectPendingQuestions,
  type KiloAssistantInfo,
} from "./sessions.js";
import {
  createStreamState,
  appendText,
  recordTokens,
  finalizeResponseText,
  detectFlowViolation,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  classifyRetry,
  summarizeUsage,
} from "../shared/index.js";
import { processStreamEvent, finalizePartsIntoState } from "./events.js";

// ── Active session registry ─────────────────────────────────────────────────
//
// Tracks the in-flight Kilo session id per chat so gateway actions (e.g.
// abort on user `/cancel`, refresh MCP on plugin reload) can reach into a
// running turn without going through chat state.

const activeSessions = new Map<string, string>();

/** Get the in-flight Kilo session id for a chat, if a turn is running. */
export function getActiveSession(chatId: string): string | undefined {
  return activeSessions.get(chatId);
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getConfig();
  if (!config) throw new Error("Kilo agent not initialized");

  const {
    chatId,
    text,
    senderName,
    isGroup,
    messageId,
    onTextBlock,
    onStreamDelta,
    onToolUse,
  } = params;
  const t0 = Date.now();
  const session = getSession(chatId);
  const previousTurns = session.turns;

  // Resolve active model + provider lookup against Kilo's catalog
  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const { providerID: selectedProviderID, modelID } =
    parseStoredKiloModelSelection(activeModel);

  const oc = await ensureServer();
  const providerID =
    selectedProviderID ?? (await resolveProviderID(oc, modelID));
  const sessionId = await ensureSession(oc, chatId);
  const chatMcpServerName = await ensureChatMcpServer(oc, chatId);
  await ensurePluginMcpServers(oc, chatId);
  const toolOverrides = await buildToolOverrides(oc, chatMcpServerName);

  // Build the prompt (time tag + sender + msg_id reference)
  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });

  // First-turn system-prompt rebuild + Kilo-specific delivery suffix
  const systemPrompt = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: KILO_SYSTEM_PROMPT_SUFFIX,
  });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });
  activeSessions.set(chatId, sessionId);

  const state = createStreamState();
  state.newSessionId = sessionId;
  const promptStartedAt = Date.now();
  const seenQuestionIds = new Set<string>();
  const seenToolCallIds = new Set<string>();

  try {
    // Drive the Kilo turn: subscribe to SSE events in parallel with
    // promptAsync, surface deltas + tool calls into shared state, and
    // exit when the turn closes / goes idle.
    await runKiloTurn({
      oc,
      sessionId,
      prompt,
      systemPrompt,
      providerID,
      modelID,
      toolOverrides,
      state,
      chatId,
      seenQuestionIds,
      seenToolCallIds,
      onStreamDelta,
      onTextBlock,
      onToolUse,
    });
  } catch (err) {
    const classified = classify(err);
    incrementCounter(`errors.${classified.reason ?? "unknown"}`);

    const decision = classifyRetry({
      error: classified,
      activeModel,
      retried: _retried,
    });

    if (decision.kind === "reset_and_retry") {
      logWarn(
        "agent",
        `[${chatId}] Kilo ${decision.reason}, resetting session and retrying`,
      );
      resetSession(chatId);
      return handleMessage(params, true);
    }

    if (decision.kind === "fallback_model") {
      logWarn(
        "agent",
        `[${chatId}] ${classified.reason}, falling back to ${decision.fallbackModelId}`,
      );
      resetSession(chatId);
      const originalModel = getChatSettings(chatId).model;
      setChatModel(chatId, decision.fallbackModelId);
      try {
        return await handleMessage(params, true);
      } finally {
        setChatModel(chatId, originalModel);
      }
    }

    logError("agent", `[${chatId}] Kilo error: ${classified.message}`);
    throw classified;
  } finally {
    if (activeSessions.get(chatId) === sessionId) {
      activeSessions.delete(chatId);
    }
    await disconnectChatMcpServer(oc, chatMcpServerName);
  }

  // ── Post-loop accounting ──────────────────────────────────────────────────

  // If the SSE loop missed any usage info, fall back to the session
  // summary endpoint (which always reflects the final state on the server).
  if (
    state.sdkInputTokens === 0 &&
    state.sdkOutputTokens === 0 &&
    state.sdkCacheRead === 0
  ) {
    try {
      const summary = await getKiloTurnSummary(oc, sessionId, promptStartedAt);
      if (summary.usage.assistantMessages > 0) {
        recordTokens(state, {
          inputTokens: summary.usage.inputTokens,
          outputTokens: summary.usage.outputTokens,
          cacheRead: summary.usage.cacheRead,
          cacheWrite: summary.usage.cacheWrite,
        });
      }
    } catch {
      // best-effort — Kilo session summaries can race on cancellation
    }
  }

  const responseText = finalizeResponseText(state);
  const durationMs = Date.now() - t0;
  recordHistogram("response_latency_ms", durationMs);
  incrementCounter("queries_total");

  if (state.newSessionId) {
    // setSessionId tolerates "same id" calls — keep it simple.
    const stored = getSession(chatId).sessionId;
    if (stored !== state.newSessionId) {
      // Defer to the storage helper to keep its invariants.
      const { setSessionId } = await import("../../storage/sessions.js");
      setSessionId(chatId, state.newSessionId);
    }
  }

  incrementTurns(chatId);
  recordUsage(chatId, {
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
    durationMs,
    model: activeModel,
  });

  // Set a descriptive session name from the user's first message
  if (previousTurns === 0) {
    const name = extractSessionName(text);
    if (name) setSessionName(chatId, name);
  }

  // ── Flow-violation re-prompt ──────────────────────────────────────────────

  const violation = detectFlowViolation({
    trailingText: state.lastTrailingText || responseText,
    turnTerminated: state.turnTerminated,
    deliveredTextNorms: state.deliveredTextNorms,
    retried: _retried,
  });

  if (violation.violated) {
    incrementCounter("scratchpad.trailing_text_dropped");
    log(
      "agent",
      `[${chatId}] flow violation (Kilo): trailing prose (${violation.trailing.length} chars) ` +
        `without end_turn/send. ${
          violation.shouldRetry
            ? "Re-prompting with reminder."
            : "Already retried — accepting silent drop."
        }`,
    );
    if (violation.shouldRetry) {
      incrementCounter("scratchpad.flow_violation_retried");
      return handleMessage({ ...params, text: violation.reminder }, true);
    }
  }

  // ── Final delivery ────────────────────────────────────────────────────────
  //
  // Two delivery paths converge here:
  //
  //   1. Tool-driven delivery (`end_turn` / `send`) — text already shipped
  //      to the user inside the tool call. `state.deliveredTextNorms` is
  //      non-empty and `responseText` may also contain a duplicate. We
  //      DON'T re-emit through onTextBlock in this case (dedup short-
  //      circuits in flow-violation check above).
  //
  //   2. Plain assistant text — no delivery tool fired. The model returned
  //      a conversational reply as raw text. We emit it via onTextBlock so
  //      the frontend ships it as a regular Telegram message.

  if (
    onTextBlock &&
    !state.turnTerminated &&
    responseText &&
    !violation.violated
  ) {
    try {
      await onTextBlock(responseText);
    } catch (err) {
      logWarn("agent", `[${chatId}] onTextBlock failed: ${errMsg(err)}`);
    }
  }

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
  traceMessage(chatId, "out", responseText, {
    durationMs,
    toolCalls: state.toolCalls,
  });

  return {
    text: responseText,
    durationMs,
    inputTokens: state.sdkInputTokens,
    outputTokens: state.sdkOutputTokens,
    cacheRead: state.sdkCacheRead,
    cacheWrite: state.sdkCacheWrite,
  };
}

// ── Internal: run one Kilo turn with SSE streaming ─────────────────────────

interface RunKiloTurnInputs {
  oc: KiloClient;
  sessionId: string;
  prompt: string;
  systemPrompt: string;
  providerID: string;
  modelID: string;
  toolOverrides: Record<string, boolean> | undefined;
  state: ReturnType<typeof createStreamState>;
  chatId: string;
  seenQuestionIds: Set<string>;
  seenToolCallIds: Set<string>;
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
}

/**
 * Run one Kilo turn end-to-end.
 *
 * Strategy:
 *   1. Send the prompt via `session.prompt` (the Kilo HTTP API returns
 *      after the turn completes; long timeouts are normal).
 *   2. In parallel, parse the response parts as they accumulate into the
 *      stream state. Kilo's REST `prompt` does NOT stream — but the parts
 *      list lands once the turn closes, and SSE events run alongside for
 *      mid-turn progress.
 *   3. When `end_turn` / `send` / `react` is detected, optionally call
 *      `session.abort()` to short-circuit the model's "wrap up" round
 *      trip the way Claude SDK's PostToolBatch hook does.
 *
 * Why we still call `prompt` (not `promptAsync` + SSE-only):
 *   The synchronous `session.prompt` endpoint atomically returns the full
 *   `parts` array on completion. Combining it with SSE for progress
 *   updates gives us streaming UX (deltas, mid-turn tool callbacks) AND
 *   bulletproof final-state capture. Using `promptAsync` would force us
 *   to recover the final parts via a follow-up `session.messages` call —
 *   one more round-trip with no benefit for non-aborted turns.
 */
async function runKiloTurn(inputs: RunKiloTurnInputs): Promise<void> {
  const {
    oc,
    sessionId,
    prompt,
    systemPrompt,
    providerID,
    modelID,
    toolOverrides,
    state,
    chatId,
    seenQuestionIds,
    seenToolCallIds,
    onStreamDelta,
    onTextBlock,
    onToolUse,
  } = inputs;

  // Set up SSE subscription for mid-turn deltas + tool detection
  const sseAbort = new AbortController();
  const sseDone = subscribeToTurnEvents({
    oc,
    sessionId,
    state,
    chatId,
    seenToolCallIds,
    onStreamDelta,
    onTextBlock,
    onToolUse,
    onTerminator: async () => {
      // End_turn fired — abort the in-flight session so the model
      // doesn't burn another round-trip "wrapping up" after declaring
      // done. The prompt() call below will reject with an abort error
      // which the caller's retry classifier ignores (turnTerminated is
      // set).
      try {
        await oc.session.abort({ sessionID: sessionId });
      } catch (err) {
        logWarn("agent", `[${chatId}] session.abort failed: ${errMsg(err)}`);
      }
    },
    abortSignal: sseAbort.signal,
  });

  // Watchdog: reject pending Kilo questions in the background. Talon
  // manages its own tool permissions, so any question Kilo raises mid-
  // turn (tool approval, follow-up clarification) is auto-handled.
  const questionWatchdog = (async () => {
    while (!sseAbort.signal.aborted) {
      try {
        await rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds);
      } catch (err) {
        logWarn(
          "agent",
          `[${chatId}] question watchdog failed: ${errMsg(err)}`,
        );
      }
      await sleep(350, sseAbort.signal);
    }
  })();

  try {
    // Synchronous prompt — returns when the turn closes (success or abort)
    const resp = await oc.session.prompt({
      sessionID: sessionId,
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
      system: systemPrompt,
      ...(toolOverrides ? { tools: toolOverrides } : {}),
    });

    // Post-turn: process the final parts list as authoritative state.
    // The SSE handler may have caught some of these mid-flight, but the
    // sync response is the source of truth for what landed.
    const data = resp.data as Record<string, unknown> | undefined;
    const parts = Array.isArray(data?.parts)
      ? (data.parts as Array<Record<string, unknown>>)
      : [];
    const assistantInfo =
      data?.info && typeof data.info === "object"
        ? (data.info as KiloAssistantInfo)
        : undefined;

    finalizePartsIntoState({
      parts,
      state,
      seenToolCallIds,
      onToolUse,
    });

    if (assistantInfo) {
      const usage = extractAssistantUsage(assistantInfo);
      // Only fill from sync response when SSE didn't already set non-zero
      // counts (avoids double-attributing on backends that emit usage in
      // both places).
      if (state.sdkInputTokens === 0 && state.sdkOutputTokens === 0) {
        recordTokens(state, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        });
      }
    }

    // Some Kilo turns return a parts list missing the assistant text
    // entirely (race between session.prompt close and message persist).
    // The fallback poll waits up to 10s for the assistant message to land
    // in the session-messages endpoint.
    if (
      !state.allResponseText &&
      !state.currentBlockText &&
      !state.turnTerminated
    ) {
      const fallback = await waitForAssistantReply(
        oc,
        sessionId,
        Date.now() - 60_000,
        chatId,
        seenQuestionIds,
      );
      if (fallback.text) {
        // Replay through the same state-mutator path so dedup + tool
        // tracking stay consistent.
        appendText(state, fallback.text);
      }
    }
  } catch (err) {
    // If the model called end_turn, we intentionally aborted — the
    // resulting "request aborted" error must NOT propagate.
    if (state.turnTerminated && /abort/i.test(errMsg(err))) {
      return;
    }
    throw err;
  } finally {
    sseAbort.abort();
    await sseDone.catch(() => {});
    await questionWatchdog.catch(() => {});
    // Final cleanup: reject any pending questions that landed in the
    // brief window between abort and finally.
    try {
      await rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds);
    } catch {
      /* noop */
    }
  }
}

// ── SSE subscription ───────────────────────────────────────────────────────

interface SubscribeInputs {
  oc: KiloClient;
  sessionId: string;
  state: ReturnType<typeof createStreamState>;
  chatId: string;
  seenToolCallIds: Set<string>;
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  onTerminator: () => Promise<void>;
  abortSignal: AbortSignal;
}

/**
 * Subscribe to Kilo's global SSE event stream and translate relevant
 * events into stream-state mutations / callback firings.
 *
 * Only events scoped to our `sessionId` are processed; others get
 * dropped silently. The subscription is closed via `abortSignal` and
 * any error is logged but does not propagate (the sync `prompt` is
 * the source-of-truth fallback).
 */
async function subscribeToTurnEvents(inputs: SubscribeInputs): Promise<void> {
  const {
    oc,
    sessionId,
    state,
    chatId,
    seenToolCallIds,
    onStreamDelta,
    onTextBlock,
    onToolUse,
    onTerminator,
    abortSignal,
  } = inputs;

  let stream: AsyncIterable<unknown> | undefined;
  try {
    // The SDK's `global.event()` returns a `ServerSentEventsResult` whose
    // `stream` field is an async iterable of typed events.
    const sse = (await oc.global.event()) as unknown as {
      stream?: AsyncIterable<unknown>;
    };
    stream = sse?.stream;
  } catch (err) {
    logWarn("agent", `[${chatId}] SSE subscribe failed: ${errMsg(err)}`);
    return;
  }

  if (!stream) return;

  try {
    for await (const evt of stream) {
      if (abortSignal.aborted) break;
      if (!evt || typeof evt !== "object") continue;

      const event = evt as {
        type?: string;
        properties?: Record<string, unknown>;
      };

      // session.error is observed here for logging; everything else goes
      // through the shared pure helper.
      if (event.type === "session.error") {
        const errProp = (event.properties ?? {}).error as
          | { name?: string }
          | undefined;
        if (errProp?.name) {
          logWarn("agent", `[${chatId}] Kilo session.error: ${errProp.name}`);
        }
        continue;
      }

      const outcome = await processStreamEvent(event, {
        sessionId,
        state,
        seenToolCallIds,
        onStreamDelta,
        onTextBlock,
        onToolUse,
      });

      if (outcome.kind === "terminator_fired") {
        incrementCounter(`tool_calls.${outcome.toolName}`);
        // Fire-and-forget — abort the session so the model's post-
        // end_turn wrap-up doesn't burn another API call.
        onTerminator().catch(() => {});
        continue;
      }

      if (outcome.kind === "stop") {
        if (outcome.reason === "out_of_scope") continue;
        return; // turn.close or idle — stop iterating
      }
    }
  } catch (err) {
    // SSE iteration errors are non-fatal — sync prompt() is the source
    // of truth for the turn result.
    if (!abortSignal.aborted) {
      logWarn("agent", `[${chatId}] SSE iteration failed: ${errMsg(err)}`);
    }
  }
}

// ── Sleep with abort ────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => resolve(), ms);
    if (signal) {
      const onAbort = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
