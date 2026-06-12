/**
 * OpenCode main message handler.
 *
 * Orchestrates the full turn lifecycle on top of OpenCode's HTTP API +
 * SSE event stream. Behaviour mirrors `kilo/handler.ts` and shares its
 * non-SDK-specific primitives via `../shared/` and `../remote-server/`:
 *
 *   - Stream state accumulator (text, tool calls, trailing prose, etc.)
 *   - Tool-use detection + turn-terminator handling (end_turn / send / react)
 *   - Progress-text emission before each tool call
 *   - Model fallback on rate-limit / overload / network
 *   - Context-overflow + session-expiry recovery
 *   - First-turn system-prompt rebuild + plugin prompt additions
 *   - `[YYYY-MM-DD HH:MM:SS] [Name] [msg_id:N]` prompt formatting
 *
 * What's OpenCode-specific (lives here, not in shared):
 *
 *   - Reading events from OpenCode's SSE stream (`global.event()`).
 *   - Calling `session.abort()` to terminate on `end_turn`.
 *   - Provider lookup against OpenCode's `/provider/list` endpoint.
 *
 * The streaming + event-processing logic is shared with the Kilo backend
 * (both wrap forks of the same upstream HTTP API). See
 * `backend/remote-server/events.ts`.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { QueryParams, QueryResult } from "../shared/handler-types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionId,
  setSessionName,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";

import {
  ensureServer,
  ensureSession,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  resolveProviderID,
  parseStoredOpenCodeModelSelection,
  getConfig,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
} from "./server.js";
import {
  extractPartsSummary,
  extractAssistantUsage,
  getOpenCodeTurnSummary,
  rejectPendingQuestions,
  type OpenCodeAssistantInfo,
} from "./sessions.js";
import {
  createStreamState,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  summarizeUsage,
  routeDelivery,
  sleep,
  applyRetryDecision,
  recordTurnMetrics,
  recordFailedTurnAccounting,
} from "../shared/index.js";
import {
  processStreamEvent,
  finalizePartsIntoState,
} from "../remote-server/events.js";
import { subscribeSseStream } from "../remote-server/sse-stream.js";
import { findLastAssistantMessage as findLastAssistantMessageShared } from "../remote-server/messages.js";

// ── Local utility ───────────────────────────────────────────────────────────

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// ── Active session registry ─────────────────────────────────────────────────
//
// Tracks the in-flight OpenCode session id per chat so gateway actions
// (e.g. abort on user `/cancel`, refresh MCP on plugin reload) can reach
// into a running turn without going through chat state.

const activeSessions = new Map<string, string>();

/** Get the in-flight OpenCode session id for a chat, if a turn is running. */
export function getActiveSession(chatId: string): string | undefined {
  return activeSessions.get(chatId);
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  const config = getConfig();
  if (!config) throw new Error("OpenCode agent not initialized");

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

  // Resolve active model + provider lookup against OpenCode's catalog
  const chatSettings = getChatSettings(chatId);
  const activeModel = params.model ?? chatSettings.model ?? config.model;
  const { providerID: selectedProviderID, modelID } =
    parseStoredOpenCodeModelSelection(activeModel);

  const oc = await ensureServer();
  const providerID =
    selectedProviderID ?? (await resolveProviderID(oc, modelID));
  log(
    "agent",
    `[${chatId}] OpenCode model resolved: provider=${providerID} model=${modelID}` +
      (selectedProviderID ? "" : " (provider via catalog lookup)"),
  );
  const sessionId = await ensureSession(oc, chatId);
  await ensureChatMcpServer(oc, chatId);
  await ensurePluginMcpServers(oc, chatId);

  // Build the prompt (time tag + sender + msg_id reference)
  const prompt = formatUserPrompt({
    text,
    senderName: senderName ?? "user",
    isGroup,
    messageId,
  });

  // Per-session frozen prompt + OpenCode-specific delivery suffix
  const { text: systemPrompt } = prepareSystemPrompt({
    config,
    previousTurns,
    backendSuffix: OPENCODE_SYSTEM_PROMPT_SUFFIX,
    chatId,
    sessionEpoch: session.createdAt,
  });

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });
  activeSessions.set(chatId, sessionId);

  // Bind the stream state to the chat so token mutators mirror counts
  // into the live-turn overlay — /status updates while the turn runs.
  const state = createStreamState(chatId);
  state.newSessionId = sessionId;
  const promptStartedAt = Date.now();
  const seenQuestionIds = new Set<string>();
  const seenToolCallIds = new Set<string>();

  const setupMs = Date.now() - t0;
  let promptMs = 0;

  try {
    // Drive the OpenCode turn: subscribe to SSE events in parallel with
    // promptAsync, surface tool calls + terminator into shared state,
    // and exit when the turn closes / goes idle.
    //
    // Note: `onStreamDelta` is intentionally NOT forwarded. Telegram's
    // delivery contract is "send the final reply once" — Talon doesn't
    // want live edit_message updates exposing the model's chain-of-thought
    // scratchpad to the user. We still process delta events (for tool-call
    // detection and the eventCounts diagnostic), just without the UI
    // callback firing per token. Final delivery happens through `end_turn`
    // / `send` tool calls, which call `onTextBlock` once with the
    // committed message.
    const turnStart = Date.now();
    await runOpenCodeTurn({
      oc,
      sessionId,
      prompt,
      systemPrompt,
      providerID,
      modelID,
      state,
      chatId,
      seenQuestionIds,
      seenToolCallIds,
      onStreamDelta: undefined,
      onTextBlock,
      onToolUse,
    });
    promptMs = Date.now() - turnStart;
  } catch (err) {
    const outcome = await applyRetryDecision({
      err,
      chatId,
      activeModel,
      retried: _retried,
      params,
      recurseWithRetried: (p) => handleMessage(p, true),
      backendLabel: "OpenCode",
    });
    if (outcome.retry) return outcome.retry;

    // Terminal failure — account for whatever the turn consumed before
    // dying and drop the live overlay (the retry path above did its own
    // accounting inside the recursive attempt).
    recordFailedTurnAccounting({
      backend: "opencode",
      chatId,
      durationMs: Date.now() - t0,
      toolCalls: state.toolCalls,
      apiCalls: state.numApiCalls,
      model: activeModel,
      usage: {
        inputTokens: state.sdkInputTokens,
        outputTokens: state.sdkOutputTokens,
        cacheRead: state.sdkCacheRead,
        cacheWrite: state.sdkCacheWrite,
      },
      contextTokens: state.contextTokens,
      contextWindow: state.contextWindow,
    });

    logError(
      "agent",
      `[${chatId}] OpenCode error: ${outcome.classified.message}`,
    );
    throw outcome.classified;
  } finally {
    if (activeSessions.get(chatId) === sessionId) {
      activeSessions.delete(chatId);
    }
    // Note: we deliberately do NOT disconnect the chat MCP server here.
    // The server is named per-chat (`talon-tools-<chatId>`) so it's safe
    // to keep across turns of the same chat, and re-spawning the
    // subprocess each turn was costing ~800ms per message. The local
    // registration cache (server.ts) skips the duplicate `add` calls now.
    // The chat-switch disconnect dance (see `remote-server/mcp.ts`) handles
    // visibility scoping when the active chat changes.
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
      const summary = await getOpenCodeTurnSummary(
        oc,
        sessionId,
        promptStartedAt,
      );
      if (summary.usage.assistantMessages > 0) {
        recordTokens(state, {
          inputTokens: summary.usage.inputTokens,
          outputTokens: summary.usage.outputTokens,
          cacheRead: summary.usage.cacheRead,
          cacheWrite: summary.usage.cacheWrite,
        });
      }
    } catch {
      // best-effort — session summaries can race on cancellation
    }
  }

  const responseText = finalizeResponseText(state);
  const durationMs = Date.now() - t0;
  recordTurnMetrics({
    backend: "opencode",
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

  if (state.newSessionId) {
    const stored = getSession(chatId).sessionId;
    if (stored !== state.newSessionId) {
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

  // ── Delivery ──────────────────────────────────────────────────────────────
  //
  // Decision tree shared with the Kilo backend — see
  // `backend/shared/delivery.ts` for the full rationale + the four
  // routes (tool / synthetic-error / text-part / empty).
  const delivery = await routeDelivery({
    backendLabel: "OpenCode",
    chatId,
    state,
    responseText,
    onTextBlock,
  });

  log(
    "agent",
    `[${chatId}] delivery: ${delivery.route} (${delivery.chars} chars)`,
  );

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
    )} terminator=${state.turnTerminated ? "yes" : "no"} ` +
      `delivered=${state.deliveredTextNorms.length} ` +
      `respLen=${responseText.length} ` +
      `setup=${setupMs}ms turn=${promptMs}ms ` +
      `events=${formatEventCounts(state.eventCounts)})`,
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

// ── Logging helpers ────────────────────────────────────────────────────────

function formatEventCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  return entries
    .map(([type, n]) => `${type.replace(/^(message|session)\./, "")}×${n}`)
    .join(",");
}

// ── Internal: run one OpenCode turn with SSE streaming ─────────────────────

interface RunOpenCodeTurnInputs {
  oc: OpencodeClient;
  sessionId: string;
  prompt: string;
  systemPrompt: string;
  providerID: string;
  modelID: string;
  state: ReturnType<typeof createStreamState>;
  chatId: string;
  seenQuestionIds: Set<string>;
  seenToolCallIds: Set<string>;
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
}

/**
 * Run one OpenCode turn end-to-end.
 *
 * Strategy:
 *   1. Subscribe to SSE BEFORE issuing the prompt so no early events are
 *      lost. The subscription tracks state mutations (tool calls,
 *      synthetic errors, partID→type lookups) and resolves its promise
 *      when the turn ends — `session.turn.close`, `session.idle`, or
 *      `session.error` for our session.
 *   2. Fire the prompt via `session.promptAsync`. That POST returns
 *      immediately with a messageID; OpenCode runs the model task in
 *      the background and emits SSE events as it goes.
 *   3. Await the SSE close event. Talon's await is therefore on event
 *      iteration we control — never on a long-running HTTP call we
 *      can't interrupt. If the upstream stalls, OpenCode eventually
 *      fires `session.error` (rate limit, timeout, model-not-found,
 *      etc.) which closes the turn from the same path.
 *   4. Read the authoritative parts list via `session.messages` and
 *      drain it through `finalizePartsIntoState`.
 *
 * Why we don't use `session.prompt` (sync):
 *   The sync endpoint holds the connection open until the upstream
 *   model finishes. When the upstream stalls (free providers, network
 *   blips), the HTTP POST hangs and our `await` blocks forever. With
 *   `promptAsync` + SSE, "the model is taking too long" becomes "no
 *   events arriving" — observable and abortable.
 */
async function runOpenCodeTurn(inputs: RunOpenCodeTurnInputs): Promise<void> {
  const {
    oc,
    sessionId,
    prompt,
    systemPrompt,
    providerID,
    modelID,
    state,
    chatId,
    seenQuestionIds,
    seenToolCallIds,
    onStreamDelta,
    onTextBlock,
    onToolUse,
  } = inputs;

  // SSE subscription FIRST — early `session.turn.open` and
  // `message.part.updated` events can fire immediately after
  // promptAsync returns, so the iterator must already be alive.
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
      // End_turn fired — abort the in-flight session so OpenCode doesn't
      // burn another round-trip "wrapping up" after the model declared
      // done. session.idle then fires for our session and the SSE
      // iterator exits cleanly.
      try {
        await oc.session.abort({ sessionID: sessionId });
      } catch (err) {
        logWarn("agent", `[${chatId}] session.abort failed: ${errMsg(err)}`);
      }
    },
    abortSignal: sseAbort.signal,
  });

  // Question watchdog: Talon manages its own tool permissions, so any
  // upstream-side question (tool approval, clarification) is auto-handled.
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
    // Fire and forget — promptAsync returns immediately. The HTTP POST
    // itself can't hang us; the await below is on the SSE close event.
    await oc.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
      system: systemPrompt,
    });

    // Await turn completion via SSE.
    await sseDone;

    // Read authoritative final state from the messages endpoint.
    const messagesResp = await oc.session.messages({ sessionID: sessionId });
    const messages = Array.isArray(messagesResp.data)
      ? (messagesResp.data as Array<Record<string, unknown>>)
      : [];
    const lastAssistant = findLastAssistantMessage(messages);
    const parts = lastAssistant?.parts ?? [];
    const assistantInfo = lastAssistant?.info;

    finalizePartsIntoState({
      parts,
      state,
      seenToolCallIds,
      extractPartsSummary,
      onToolUse,
    });

    if (assistantInfo) {
      const usage = extractAssistantUsage(assistantInfo);
      if (state.sdkInputTokens === 0 && state.sdkOutputTokens === 0) {
        recordTokens(state, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        });
      }
    }
  } catch (err) {
    // If the model called end_turn we aborted intentionally — swallow.
    if (state.turnTerminated && /abort/i.test(errMsg(err))) {
      return;
    }
    throw err;
  } finally {
    sseAbort.abort();
    await sseDone.catch(() => {});
    await questionWatchdog.catch(() => {});
    try {
      await rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds);
    } catch {
      /* noop */
    }
  }
}

/**
 * Find the most recent assistant message in a session-messages list
 * and surface its parts + assistant info in a uniform shape.
 */
// Shared walker — see `remote-server/messages.ts`. The runtime guard +
// `info` typing live there once; the generic `Info` parameter labels
// what we consume.
const findLastAssistantMessage = (
  messages: Array<Record<string, unknown>>,
): {
  parts: Array<Record<string, unknown>>;
  info?: OpenCodeAssistantInfo;
} | null => findLastAssistantMessageShared<OpenCodeAssistantInfo>(messages);

// ── SSE subscription ───────────────────────────────────────────────────────

interface SubscribeInputs {
  oc: OpencodeClient;
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
 * Subscribe to OpenCode's global SSE event stream and translate
 * relevant events into stream-state mutations / callback firings.
 *
 * Only events scoped to our `sessionId` are processed; others get
 * dropped silently. The subscription is closed via `abortSignal` and
 * any error is logged but does not propagate.
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

  // `subscribeSseStream` handles the `as unknown as { stream }` narrowing
  // with a runtime guard + the subscribe-failed warning.
  const stream = await subscribeSseStream(oc, chatId);
  if (!stream) return;

  try {
    for await (const evt of stream) {
      if (abortSignal.aborted) break;
      if (!evt || typeof evt !== "object") continue;

      // OpenCode's SSE wire format wraps every event in
      // `{payload: {type, properties}}` — same as Kilo.
      const payload =
        evt && typeof evt === "object" && "payload" in evt
          ? (evt as { payload?: unknown }).payload
          : evt;
      if (!payload || typeof payload !== "object") continue;
      const event = payload as {
        type?: string;
        properties?: Record<string, unknown>;
      };

      // session.error scope-filter to our own sessionId before
      // attributing the error to this chat — the SSE stream is global
      // and a heartbeat session.error would otherwise pollute the
      // chat's log.
      if (event.type === "session.error") {
        const props = event.properties ?? {};
        const evtSessionID =
          typeof props.sessionID === "string" ? props.sessionID : undefined;
        if (evtSessionID && evtSessionID !== sessionId) {
          continue;
        }
        const errProp = props.error as
          | {
              name?: string;
              message?: string;
              data?: Record<string, unknown>;
            }
          | undefined;
        // MessageAbortedError is our own abort signal when a terminator
        // tool fired; expected close path, not an upstream failure.
        const isOurAbort =
          state.turnTerminated &&
          (errProp?.name === "MessageAbortedError" ||
            /abort/i.test(errProp?.name ?? "") ||
            /abort/i.test(errProp?.message ?? ""));
        if (errProp && !isOurAbort) {
          const detail = [
            errProp.name && `name=${errProp.name}`,
            errProp.message && `message=${errProp.message}`,
            errProp.data && `data=${JSON.stringify(errProp.data)}`,
          ]
            .filter(Boolean)
            .join(" ");
          logWarn("agent", `[${chatId}] OpenCode session.error: ${detail}`);
          const msg = errProp.message ?? errProp.name;
          if (msg) state.syntheticError = msg;
        }
        return;
      }

      const outcome = await processStreamEvent(event, {
        sessionId,
        state,
        seenToolCallIds,
        backendLabel: "OpenCode",
        onStreamDelta,
        onTextBlock,
        onToolUse,
      });

      if (outcome.kind === "terminator_fired") {
        onTerminator().catch(() => {});
        continue;
      }

      if (outcome.kind === "stop") {
        if (outcome.reason === "out_of_scope") continue;
        return; // turn.close or idle — stop iterating
      }
    }
  } catch (err) {
    if (!abortSignal.aborted) {
      logWarn("agent", `[${chatId}] SSE iteration failed: ${errMsg(err)}`);
    }
  }
}

// (`sleep` lives in `../shared/sleep.ts` — see import at the top.)
