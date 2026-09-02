/**
 * Run one turn over the remote server's HTTP API + SSE event stream.
 *
 * `runRemoteTurn` subscribes to SSE before issuing the prompt (so no early
 * events are lost), fires `promptAsync`, awaits the SSE close, then reads
 * the authoritative parts list. `subscribeToTurnEvents` translates the
 * relevant SSE events into shared stream-state mutations and observes the
 * turn going idle.
 *
 * Kilo and OpenCode share the SSE schema (Kilo is a fork), so this is one
 * implementation parameterised by the backend label. The two per-backend
 * copies it replaces had already drifted apart in comments only.
 */

import { logWarn } from "../../util/log.js";
import { createStreamState, recordTokens, sleep } from "../shared/index.js";
import { processStreamEvent, finalizePartsIntoState } from "./events.js";
import { findLastAssistantMessage } from "./messages.js";
import {
  approvePendingPermissions,
  extractAssistantUsage,
  extractPartsSummary,
  rejectPendingQuestions,
  type RemoteAssistantInfo,
  type RemoteSessionClient,
} from "./session-helpers.js";
import {
  subscribeSseStream,
  type SseSubscribableClient,
} from "./sse-stream.js";
import { errMsg } from "./state.js";
import { awaitRemoteTurn, type RemoteTurnAbortClient } from "./turn-timeout.js";

/**
 * The slice of the SDK client a turn touches. Both concrete SDK clients
 * satisfy it structurally; callers holding a typed SDK client cast.
 */
export interface RemoteTurnClient
  extends SseSubscribableClient, RemoteTurnAbortClient {
  session: RemoteTurnAbortClient["session"] & {
    promptAsync(args: {
      sessionID: string;
      parts: Array<{ type: "text"; text: string }>;
      model: { providerID: string; modelID: string };
      system: string;
      tools?: Record<string, boolean>;
    }): Promise<unknown>;
    messages(args: { sessionID: string }): Promise<{ data?: unknown }>;
  };
  question: RemoteSessionClient["question"];
  permission: RemoteSessionClient["permission"];
}

export interface RunRemoteTurnInputs {
  /** Backend label for log lines ("Kilo", "OpenCode"). */
  label: string;
  oc: RemoteTurnClient;
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
 * Run one turn end-to-end.
 *
 * Strategy:
 *   1. Subscribe to SSE BEFORE issuing the prompt so no early events are
 *      lost. The subscription tracks state mutations and resolves when the
 *      turn ends (`session.turn.close` / `session.idle` / `session.error`).
 *   2. Fire the prompt via `session.promptAsync` — returns immediately;
 *      the server runs the model task in the background and emits SSE.
 *   3. Await the SSE close event — Talon's await is on event iteration we
 *      control, never on a long-running HTTP call we can't interrupt.
 *   4. Read the authoritative parts list via `session.messages` and drain
 *      it through `finalizePartsIntoState`.
 */
export async function runRemoteTurn(
  inputs: RunRemoteTurnInputs,
): Promise<void> {
  const {
    label,
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
  const sessionClient = oc as unknown as RemoteSessionClient;

  // SSE subscription FIRST — `session.turn.open` and early
  // `message.part.updated` events can fire immediately after promptAsync
  // returns, so the iterator must already be alive.
  const sseAbort = new AbortController();
  const sseDone = subscribeToTurnEvents({
    label,
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
  const settlePending = (): Promise<unknown> =>
    Promise.all([
      rejectPendingQuestions(
        sessionClient,
        sessionId,
        chatId,
        seenQuestionIds,
        label,
      ),
      approvePendingPermissions(
        sessionClient,
        sessionId,
        chatId,
        seenPermissionIds,
        label,
      ),
    ]);
  const questionWatchdog = (async () => {
    while (!sseAbort.signal.aborted) {
      try {
        await settlePending();
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
        await sseDone;
      })(),
      { client: oc, sessionId, chatId, label },
    );

    // Read authoritative final state from the messages endpoint. The SSE
    // handler already populated state mid-flight; this re-reads to fill
    // anything SSE missed (race between turn.close and message persist).
    const messagesResp = await oc.session.messages({ sessionID: sessionId });
    const messages = Array.isArray(messagesResp.data)
      ? (messagesResp.data as Array<Record<string, unknown>>)
      : [];
    const lastAssistant =
      findLastAssistantMessage<RemoteAssistantInfo>(messages);
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
      await settlePending();
    } catch {
      /* noop */
    }
  }
}

interface SubscribeInputs {
  label: string;
  oc: RemoteTurnClient;
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
 * Subscribe to the server's global SSE event stream and translate relevant
 * events into stream-state mutations / callback firings. Only events scoped
 * to our `sessionId` are processed; others are dropped silently. Errors are
 * logged but do not propagate — the messages endpoint is the source of
 * truth for the turn result.
 */
async function subscribeToTurnEvents(inputs: SubscribeInputs): Promise<void> {
  const {
    label,
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
  if (!stream) throw new Error(`${label} SSE connection unavailable`);

  try {
    for await (const evt of stream) {
      if (abortSignal.aborted) break;
      if (!evt || typeof evt !== "object") continue;

      // The SSE wire format wraps every event in `{payload: {type,
      // properties}}`. Unwrap here so type/properties land where the rest
      // of the loop expects them.
      const payload =
        "payload" in evt ? (evt as { payload?: unknown }).payload : evt;
      if (!payload || typeof payload !== "object") continue;
      const event = payload as {
        type?: string;
        properties?: Record<string, unknown>;
      };

      // session.error is observed here for logging; everything else goes
      // through the shared pure helper. The SSE stream is global, so
      // scope-filter to our own sessionId before attributing the error to
      // this chat — a heartbeat session.error would otherwise pollute the
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
          logWarn("agent", `[${chatId}] ${label} session.error: ${detail}`);
          // Stash the error message so the handler's delivery branch can
          // surface it as `⚠️ <label>: <message>` instead of silence.
          const msg = errProp.message ?? errProp.name;
          if (msg) state.syntheticError = msg;
        }
        // session.error for OUR session ends the turn — the server isn't
        // going to produce more events for this prompt.
        return;
      }

      const outcome = await processStreamEvent(event, {
        chatId,
        sessionId,
        state,
        seenToolCallIds,
        backendLabel: label,
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
    if (!abortSignal.aborted) {
      logWarn("agent", `[${chatId}] SSE iteration failed: ${errMsg(err)}`);
    }
  }
}
