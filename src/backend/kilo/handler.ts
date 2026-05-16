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
  resolveProviderID,
  parseStoredKiloModelSelection,
  getConfig,
  KILO_SYSTEM_PROMPT_SUFFIX,
  errMsg,
} from "./server.js";
import {
  extractAssistantUsage,
  getKiloTurnSummary,
  rejectPendingQuestions,
  type KiloAssistantInfo,
} from "./sessions.js";
import {
  createStreamState,
  recordTokens,
  finalizeResponseText,
  formatUserPrompt,
  prepareSystemPrompt,
  extractSessionName,
  classifyRetry,
  summarizeUsage,
  routeDelivery,
  sleep,
} from "../shared/index.js";
import { processStreamEvent, finalizePartsIntoState } from "./events.js";
import { subscribeSseStream } from "../remote-server/sse-stream.js";
import { findLastAssistantMessage as findLastAssistantMessageShared } from "../remote-server/messages.js";

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
  log(
    "agent",
    `[${chatId}] Kilo model resolved: provider=${providerID} model=${modelID}` +
      (selectedProviderID ? "" : " (provider via catalog lookup)"),
  );
  const sessionId = await ensureSession(oc, chatId);
  await ensureChatMcpServer(oc, chatId);
  await ensurePluginMcpServers(oc, chatId);
  // Note: we deliberately don't pass `tools` to promptAsync below.
  // The session was created with a `permission` ruleset
  // (see ensureSession in server.ts) that allow-lists *this* chat's
  // MCP tools and deny-lists other chats' tools, plus auto-allows
  // built-in `read` / `bash` / `edit`. The deprecated `tools` map
  // and the per-prompt overrides it required are subsumed by that.

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

  const setupMs = Date.now() - t0;
  let promptMs = 0;

  try {
    // Drive the Kilo turn: subscribe to SSE events in parallel with
    // promptAsync, surface tool calls + terminator into shared state, and
    // exit when the turn closes / goes idle.
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
    await runKiloTurn({
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
    // Note: we deliberately do NOT disconnect the chat MCP server here.
    // The server is named per-chat (`talon-tools-<chatId>`) so it's safe
    // to keep across turns of the same chat, and re-spawning the
    // subprocess each turn was costing ~800ms per message. The local
    // registration cache (server.ts) skips the duplicate `add` calls now.
    // `disconnectChatMcpServer` remains exported for explicit teardown
    // (shutdown, plugin reload).
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

  // ── Delivery ──────────────────────────────────────────────────────────────
  //
  // Decision tree shared with the OpenCode backend — see
  // `backend/shared/delivery.ts` for the full rationale + the four
  // routes (tool / synthetic-error / text-part / empty).
  const delivery = await routeDelivery({
    backendLabel: "Kilo",
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

/**
 * Compact summary of which SSE event types fired this turn. `{}` for a
 * silent turn (which is itself a useful diagnostic — the SSE socket
 * either dropped or never matched our session id). Otherwise renders as
 * `delta×42,part.updated×1,turn.close×1` style.
 */
function formatEventCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "none";
  // Trim the noisy `message.` / `session.` prefixes so the line stays
  // readable in the live log tail.
  return entries
    .map(([type, n]) => `${type.replace(/^(message|session)\./, "")}×${n}`)
    .join(",");
}

// ── Internal: run one Kilo turn with SSE streaming ─────────────────────────

interface RunKiloTurnInputs {
  oc: KiloClient;
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
 * Run one Kilo turn end-to-end.
 *
 * Strategy (post-refactor):
 *   1. Subscribe to SSE BEFORE issuing the prompt so no early events are
 *      lost. The subscription tracks state mutations (tool calls,
 *      synthetic errors, partID→type lookups) and resolves its promise
 *      when the turn ends — `session.turn.close`, `session.idle`, or
 *      `session.error` for our session.
 *   2. Fire the prompt via `session.promptAsync`. That POST returns
 *      immediately with a messageID; Kilo runs the model task in the
 *      background and emits SSE events as it goes.
 *   3. Await the SSE close event. Talon's await is therefore on event
 *      iteration we control — never on a long-running HTTP call we
 *      can't interrupt. If the upstream stalls, Kilo eventually fires
 *      `session.error` (rate limit, timeout, model-not-found, etc.)
 *      which closes the turn from the same path.
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
async function runKiloTurn(inputs: RunKiloTurnInputs): Promise<void> {
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

  // SSE subscription FIRST — Kilo can fire `session.turn.open` and
  // early `message.part.updated` events immediately after promptAsync
  // returns, so the iterator must already be alive.
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
      // End_turn fired — abort the in-flight session so Kilo doesn't
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

  // Question watchdog (existing): Talon manages its own tool permissions,
  // so any Kilo-side question (tool approval, clarification) is rejected
  // automatically.
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
    // No `tools` field: the deprecated per-prompt tool override map has
    // been merged into session-level `permission` rules, which we set in
    // ensureSession (server.ts). That ruleset already constrains tool
    // visibility per chat — passing `tools` here would be redundant.
    await oc.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
      system: systemPrompt,
    });

    // Await turn completion via SSE. Resolves when the iterator hits a
    // `session.turn.close` / `session.idle` / `session.error` event for
    // our sessionId, or when sseAbort fires (manual abort path).
    await sseDone;

    // Read authoritative final state from the messages endpoint. The
    // SSE handler already populated state.allResponseText / tool calls
    // mid-flight; this re-reads to fill anything SSE missed (race
    // between turn.close and message persist) and to confirm parts.
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
 *
 * Kilo's `session.messages` returns the chronological list of all
 * messages this session has ever produced. We only care about the
 * last assistant message (the one that just landed via the prompt
 * we issued).
 */
// Shared walker — see `remote-server/messages.ts`. The runtime guard +
// `info` typing live there once; the generic `Info` parameter labels
// what we consume.
const findLastAssistantMessage = (
  messages: Array<Record<string, unknown>>,
): {
  parts: Array<Record<string, unknown>>;
  info?: KiloAssistantInfo;
} | null => findLastAssistantMessageShared<KiloAssistantInfo>(messages);

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

  // `subscribeSseStream` handles the `as unknown as { stream }` narrowing
  // with a runtime guard + the subscribe-failed warning. Returns
  // `undefined` for both "subscribe rejected" and "no iterable in the
  // response shape" — either way we exit without iterating.
  const stream = await subscribeSseStream(oc, chatId);
  if (!stream) return;

  try {
    for await (const evt of stream) {
      if (abortSignal.aborted) break;
      if (!evt || typeof evt !== "object") continue;

      // Kilo's SSE wire format wraps every event in `{payload: {type, properties}}`
      // — confirmed by curling `/global/event` directly. The earlier handler
      // read `evt.type` directly which was always undefined, so EVERY event
      // got dropped (the `events=none` summary was a 100% miss rate). Unwrap
      // here so type/properties land where the rest of the loop expects them.
      const payload =
        evt && typeof evt === "object" && "payload" in evt
          ? (evt as { payload?: unknown }).payload
          : evt;
      if (!payload || typeof payload !== "object") continue;
      const event = payload as {
        type?: string;
        properties?: Record<string, unknown>;
      };

      // session.error is observed here for logging; everything else goes
      // through the shared pure helper. Kilo's SSE stream is global —
      // session.error events fire for every session, including the
      // background heartbeat session — so scope-filter to our own
      // sessionId before attributing the error to this chat. Without
      // the scope filter, a heartbeat session.error would get logged
      // under the chat's [chatId] prefix, which is misleading enough
      // that it derailed an entire debugging session.
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
        // MessageAbortedError is OUR own abort signal — fired when a
        // terminator tool (`end_turn` / `send` / `react`) led us to call
        // `oc.session.abort` to short-circuit the model's wrap-up
        // round-trip. It's the EXPECTED close path, not an upstream
        // failure. Don't stash it on syntheticError (would surface as
        // `⚠️ Kilo: MessageAbortedError` to the user) and don't log it
        // as a warning. Just exit the SSE loop cleanly.
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
          logWarn("agent", `[${chatId}] Kilo session.error: ${detail}`);
          // Stash the error message on the stream state so the handler's
          // delivery branch can surface it as `⚠️ Kilo: <message>`
          // instead of leaving the user with silence.
          const msg = errProp.message ?? errProp.name;
          if (msg) state.syntheticError = msg;
        }
        // session.error for OUR session ends the turn — Kilo isn't going
        // to produce any more events for this prompt. Without this break
        // the SSE iterator would wait for a `turn.close` / `idle` that
        // never arrives.
        return;
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
        // tool_calls counter increment happens per-tool inside
        // events.ts processPartUpdate (parity with claude-sdk's
        // count-every-tool semantics). Don't double-count here.
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

// (`sleep` lives in `../shared/sleep.ts` — see import at the top.)
