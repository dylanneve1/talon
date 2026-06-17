/**
 * Run one OpenCode turn over the HTTP API + SSE event stream.
 *
 * `runOpenCodeTurn` subscribes to SSE before issuing the prompt (so no early
 * events are lost), fires `promptAsync`, awaits the SSE close, then reads the
 * authoritative parts list. `subscribeToTurnEvents` translates relevant SSE
 * events into shared stream-state mutations and fires the terminator abort.
 *
 * The streaming + event-processing logic is shared with the Kilo backend via
 * `backend/remote-server/events.ts`.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { logWarn } from "../../../util/log.js";
import { errMsg } from "../server.js";
import {
  extractPartsSummary,
  extractAssistantUsage,
  rejectPendingQuestions,
  type OpenCodeAssistantInfo,
} from "../sessions.js";
import { createStreamState, recordTokens, sleep } from "../../shared/index.js";
import {
  processStreamEvent,
  finalizePartsIntoState,
} from "../../remote-server/events.js";
import { subscribeSseStream } from "../../remote-server/sse-stream.js";
import { findLastAssistantMessage as findLastAssistantMessageShared } from "../../remote-server/messages.js";

export interface RunOpenCodeTurnInputs {
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
 * Run one OpenCode turn end-to-end. SSE-first strategy identical to Kilo:
 * subscribe before prompting, fire `promptAsync`, await the SSE close, then
 * read the authoritative parts list. Avoids the sync `session.prompt` which
 * would hang our await when the upstream model stalls.
 */
export async function runOpenCodeTurn(
  inputs: RunOpenCodeTurnInputs,
): Promise<void> {
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
  // `message.part.updated` events can fire immediately after promptAsync
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
    // Fire and forget — promptAsync returns immediately. The await below
    // is on the SSE close event.
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
 * Find the most recent assistant message in a session-messages list and
 * surface its parts + assistant info. Shared walker — see
 * `remote-server/messages.ts`.
 */
const findLastAssistantMessage = (
  messages: Array<Record<string, unknown>>,
): {
  parts: Array<Record<string, unknown>>;
  info?: OpenCodeAssistantInfo;
} | null => findLastAssistantMessageShared<OpenCodeAssistantInfo>(messages);

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
 * Subscribe to OpenCode's global SSE event stream and translate relevant
 * events into stream-state mutations / callback firings. Only events scoped
 * to our `sessionId` are processed; others are dropped silently. Errors are
 * logged but do not propagate.
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
  // subscribe-failed warning.
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

      // session.error scope-filter to our own sessionId before attributing
      // the error to this chat — the SSE stream is global and a heartbeat
      // session.error would otherwise pollute the chat's log.
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
