/**
 * Run one Kilo turn over the HTTP API + SSE event stream.
 *
 * `runKiloTurn` subscribes to SSE before issuing the prompt (so no early
 * events are lost), fires `promptAsync`, awaits the SSE close, then reads the
 * authoritative parts list. `subscribeToTurnEvents` translates relevant SSE
 * events into shared stream-state mutations and observes natural turn idle.
 */

import type { KiloClient } from "@kilocode/sdk/v2";
import { logWarn } from "../../../util/log.js";
import { errMsg } from "../server.js";
import {
  approvePendingPermissions,
  extractAssistantUsage,
  rejectPendingQuestions,
  type KiloAssistantInfo,
} from "../sessions.js";
import { createStreamState, recordTokens, sleep } from "../../shared/index.js";
import { processStreamEvent, finalizePartsIntoState } from "../events.js";
import { subscribeSseStream } from "../../remote-server/sse-stream.js";
import { awaitRemoteTurn } from "../../remote-server/turn-timeout.js";
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
  seenPermissionIds: Set<string>;
  seenToolCallIds: Set<string>;
  toolOverrides?: Record<string, boolean>;
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
    seenPermissionIds,
    seenToolCallIds,
    toolOverrides,
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
    abortSignal: sseAbort.signal,
  });

  // Headless-interaction watchdog: resolve upstream questions and any
  // permission requests that escaped the session ruleset.
  const questionWatchdog = (async () => {
    while (!sseAbort.signal.aborted) {
      try {
        await Promise.all([
          rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds),
          approvePendingPermissions(oc, sessionId, chatId, seenPermissionIds),
        ]);
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
    // is on the SSE close event. Per-prompt overrides hide sibling chats'
    // MCP tools while session permissions independently deny execution.
    await awaitRemoteTurn(
      (async () => {
        await oc.session.promptAsync({
          sessionID: sessionId,
          parts: [{ type: "text", text: prompt }],
          model: { providerID, modelID },
          system: systemPrompt,
          ...(toolOverrides ? { tools: toolOverrides } : {}),
        });

        // Await turn completion via SSE.
        await sseDone;
      })(),
      { client: oc, sessionId, chatId, label: "Kilo" },
    );

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
    // Explicit user interrupts abort intentionally — swallow that close path.
    if (state.turnTerminated && /abort/i.test(errMsg(err))) {
      return;
    }
    throw err;
  } finally {
    sseAbort.abort();
    // A dead SSE socket may ignore the local abort flag until another event
    // arrives. Bound cleanup so a timed-out turn cannot wedge its caller in
    // the finally block it was meant to escape.
    await Promise.race([sseDone.catch(() => {}), sleep(1_000)]);
    await questionWatchdog.catch(() => {});
    try {
      await Promise.all([
        rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds),
        approvePendingPermissions(oc, sessionId, chatId, seenPermissionIds),
      ]);
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
    abortSignal,
  } = inputs;

  // `subscribeSseStream` handles the narrowing with a runtime guard + the
  // subscribe-failed warning. Returns `undefined` for both "subscribe
  // rejected" and "no iterable in the response shape".
  const stream = await subscribeSseStream(oc, chatId);
  if (!stream) throw new Error("Kilo SSE connection unavailable");

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
        // MessageAbortedError is expected for an explicit user interrupt.
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
        // Aborting here can race with a prompt accepted immediately after
        // this turn settles and cancel that next turn on the reused session.
        // Delivery is already complete, so wait for natural idle instead.
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
