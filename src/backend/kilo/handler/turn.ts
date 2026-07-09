/**
 * Run one Kilo turn over the HTTP API + SSE event stream.
 *
 * `runKiloTurn` subscribes to SSE before issuing the prompt (so no early
 * events are lost), fires `promptAsync`, awaits the SSE close, then reads the
 * authoritative parts list. `subscribeToTurnEvents` translates relevant SSE
 * events into shared stream-state mutations and fires the terminator abort.
 */

import type { KiloClient } from "@kilocode/sdk/v2";
import { logWarn } from "../../../util/log.js";
import { errMsg } from "../server.js";
import {
  extractAssistantUsage,
  rejectPendingQuestions,
  type KiloAssistantInfo,
} from "../sessions.js";
import { createStreamState, recordTokens, sleep } from "../../shared/index.js";
import { processStreamEvent, finalizePartsIntoState } from "../events.js";
import { subscribeSseStream } from "../../remote-server/sse-stream.js";
import { findLastAssistantMessage as findLastAssistantMessageShared } from "../../remote-server/messages.js";

export interface RunKiloTurnInputs {
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
 * Strategy:
 *   1. Subscribe to SSE BEFORE issuing the prompt so no early events are
 *      lost. The subscription tracks state mutations and resolves when the
 *      turn ends (`session.turn.close` / `session.idle` / `session.error`).
 *   2. Fire the prompt via `session.promptAsync` — returns immediately;
 *      Kilo runs the model task in the background and emits SSE events.
 *   3. Await the SSE close event — Talon's await is on event iteration we
 *      control, never on a long-running HTTP call we can't interrupt.
 *   4. Read the authoritative parts list via `session.messages` and drain
 *      it through `finalizePartsIntoState`.
 */
export async function runKiloTurn(inputs: RunKiloTurnInputs): Promise<void> {
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

  // SSE subscription FIRST — Kilo can fire `session.turn.open` and early
  // `message.part.updated` events immediately after promptAsync returns,
  // so the iterator must already be alive.
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

  // Question watchdog: Talon manages its own tool permissions, so any
  // Kilo-side question (tool approval, clarification) is rejected
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
    // Fire and forget — promptAsync returns immediately. The await below
    // is on the SSE close event. No `tools` field: the deprecated
    // per-prompt tool override map is merged into session-level
    // `permission` rules set in ensureSession.
    await oc.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text", text: prompt }],
      model: { providerID, modelID },
      system: systemPrompt,
    });

    // Await turn completion via SSE.
    await sseDone;

    // Read authoritative final state from the messages endpoint. The SSE
    // handler already populated state mid-flight; this re-reads to fill
    // anything SSE missed (race between turn.close and message persist).
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
 * Find the most recent assistant message in a session-messages list and
 * surface its parts + assistant info. Kilo's `session.messages` returns the
 * full chronological list; we only care about the last assistant message.
 */
const findLastAssistantMessage = (
  messages: Array<Record<string, unknown>>,
): {
  parts: Array<Record<string, unknown>>;
  info?: KiloAssistantInfo;
} | null => findLastAssistantMessageShared<KiloAssistantInfo>(messages);

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
 * Subscribe to Kilo's global SSE event stream and translate relevant events
 * into stream-state mutations / callback firings. Only events scoped to our
 * `sessionId` are processed; others are dropped silently. Errors are logged
 * but do not propagate (the messages endpoint is the source-of-truth fallback).
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

  // `subscribeSseStream` handles the narrowing with a runtime guard + the
  // subscribe-failed warning. Returns `undefined` for both "subscribe
  // rejected" and "no iterable in the response shape".
  const stream = await subscribeSseStream(oc, chatId);
  if (!stream) return;

  try {
    for await (const evt of stream) {
      if (abortSignal.aborted) break;
      if (!evt || typeof evt !== "object") continue;

      // Kilo's SSE wire format wraps every event in
      // `{payload: {type, properties}}`. Unwrap here so type/properties
      // land where the rest of the loop expects them.
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
      // through the shared pure helper. Kilo's SSE stream is global, so
      // scope-filter to our own sessionId before attributing the error to
      // this chat.
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
        // terminator tool led us to call `oc.session.abort` to
        // short-circuit the model's wrap-up. It's the EXPECTED close
        // path, not an upstream failure.
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
          // Stash the error message so the handler's delivery branch can
          // surface it as `⚠️ Kilo: <message>` instead of silence.
          const msg = errProp.message ?? errProp.name;
          if (msg) state.syntheticError = msg;
        }
        // session.error for OUR session ends the turn — Kilo isn't going
        // to produce more events for this prompt.
        return;
      }

      const outcome = await processStreamEvent(event, {
        chatId,
        sessionId,
        state,
        seenToolCallIds,
        onStreamDelta,
        onTextBlock,
        onToolUse,
      });

      if (outcome.kind === "terminator_fired") {
        // tool_calls counter increment happens per-tool inside
        // events.ts processPartUpdate. Don't double-count here.
        // Fire-and-forget — abort the session so the model's post-end_turn
        // wrap-up doesn't burn another API call.
        onTerminator().catch(() => {});
        continue;
      }

      if (outcome.kind === "stop") {
        if (outcome.reason === "out_of_scope") continue;
        return; // turn.close or idle — stop iterating
      }
    }
  } catch (err) {
    // SSE iteration errors are non-fatal — the messages endpoint is the
    // source of truth for the turn result.
    if (!abortSignal.aborted) {
      logWarn("agent", `[${chatId}] SSE iteration failed: ${errMsg(err)}`);
    }
  }
}
