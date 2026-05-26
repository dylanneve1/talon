/**
 * `toEventStream` — convert a callback-driven `query()` handler into
 * a native `AgentEvent` async iterable.
 *
 * Each backend's `handler.ts` accepts `onStreamDelta`, `onTextBlock`,
 * and `onToolUse` callbacks that fire as the SDK stream produces
 * partial output. This wrapper reframes those callbacks as a queued
 * event source: an async generator drains the queue concurrently with
 * the underlying `query()` promise and yields the canonical
 * `AgentEvent` sequence.
 *
 * The result is per-token streaming events (text_delta), per-tool
 * events (tool_call), assistant message blocks (assistant_message),
 * and the standard `run_started → … → usage → completed` envelope.
 * Backend factories call this from their `chat.runChatTurn` slot:
 *
 *   const chat: ChatBackend = {
 *     runChatTurn: (params) => toEventStream(handleMessage, params),
 *   };
 */

import type {
  AgentError,
  AgentErrorKind,
  AgentEvent,
} from "../../core/agent-runtime/events.js";
import type { ChatRunParams } from "../../core/agent-runtime/capabilities.js";
import type { QueryParams, QueryResult } from "./handler-types.js";

/** Sentinel pushed onto the queue when the query promise settles. */
const SENTINEL = Symbol("toEventStream:sentinel");

type QueueEvent = AgentEvent | typeof SENTINEL;

/**
 * Wrap an SDK-specific callback-driven `query()` handler into the
 * canonical `AsyncIterable<AgentEvent>` shape every `ChatBackend`
 * exposes. The generator interleaves callback-driven streaming
 * events with the awaited query result:
 *
 *   run_started → text_delta* → assistant_message* → tool_call* →
 *     usage → completed
 *
 * On error: `run_started → error`.
 *
 * The wrapper builds the backend-internal `QueryParams` shape
 * (from `handler-types.ts`) out of the canonical `ChatRunParams`
 * (`ModelRef` flattens to `model.id`; no callbacks come from the
 * caller — the queue owns the streaming surface). Backends call
 * this from their factory's `chat.runChatTurn` slot.
 */
export async function* toEventStream(
  query: (params: QueryParams) => Promise<QueryResult>,
  params: ChatRunParams,
): AsyncIterable<AgentEvent> {
  yield { type: "run_started" };

  const queue: QueueEvent[] = [];
  let resolveAvailable: (() => void) | null = null;
  const wait = () =>
    new Promise<void>((resolve) => {
      resolveAvailable = resolve;
    });
  const emit = (event: QueueEvent): void => {
    queue.push(event);
    const r = resolveAvailable;
    resolveAvailable = null;
    r?.();
  };

  // The handler-internal `onStreamDelta` contract delivers the FULL
  // accumulated text so far, not the new chunk. `AgentEvent.text_delta.text`
  // carries the delta — the pipe consumer (`pipeEventsToCallbacks` /
  // `streamLog` / `event-log-renderer`) re-accumulates. To bridge the
  // two contracts, the wrapper tracks the prior accumulated value
  // and emits only the trailing slice. Backends that already deliver
  // per-token deltas via `onStreamDelta` (Codex's `agent_message`,
  // Claude SDK's stream-events) call the callback with monotonically-
  // growing accumulated strings; the diff is one chunk per call.
  let lastAccumulated = "";

  const handlerParams: QueryParams = {
    chatId: params.chatId,
    model: params.model.id,
    text: params.text,
    senderName: params.senderName,
    isGroup: params.isGroup,
    messageId: params.messageId,
    onStreamDelta: (accumulated) => {
      if (typeof accumulated !== "string" || accumulated.length === 0) {
        return;
      }
      // Monotonic-prefix case: the new accumulated extends the prior
      // one. Emit the new tail as the delta.
      let chunk = accumulated;
      if (accumulated.startsWith(lastAccumulated)) {
        chunk = accumulated.slice(lastAccumulated.length);
      }
      // Anything else (reset, replacement) — emit the full string as
      // a fresh delta and reset the accumulator. Rare but defensive.
      lastAccumulated = accumulated;
      if (chunk.length > 0) {
        emit({ type: "text_delta", text: chunk });
      }
    },
    onTextBlock: async (text) => {
      emit({ type: "assistant_message", text });
      // A block delivery anchors the accumulator — subsequent
      // streaming deltas restart from empty.
      lastAccumulated = "";
    },
    onToolUse: (toolName, input) => {
      emit({
        type: "tool_call",
        id: `${toolName}-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`,
        name: toolName,
        input,
      });
    },
  };

  let result: QueryResult | undefined;
  let error: unknown;

  const queryPromise = query(handlerParams)
    .then((r) => {
      result = r;
    })
    .catch((err) => {
      error = err;
    })
    .finally(() => {
      emit(SENTINEL);
    });

  // Drain the queue until the query settles AND no more events are
  // buffered. The sentinel only signals "query settled" — we still
  // flush any final text/tool events the handler emitted just
  // before resolving.
  let settled = false;
  while (!settled || queue.length > 0) {
    while (queue.length > 0) {
      const ev = queue.shift()!;
      if (ev === SENTINEL) {
        settled = true;
        continue;
      }
      yield ev;
    }
    if (!settled) {
      await wait();
    }
  }
  await queryPromise;

  if (error) {
    yield { type: "error", error: classifyChatError(error) };
    return;
  }

  if (!result) {
    yield {
      type: "error",
      error: {
        kind: "unknown",
        message: "query() resolved without a result.",
        retryable: false,
      },
    };
    return;
  }

  const usage = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheRead: result.cacheRead,
    cacheWrite: result.cacheWrite,
    modelId: params.model.id,
  };
  yield { type: "usage", usage };
  yield {
    type: "completed",
    result: {
      text: result.text,
      durationMs: result.durationMs,
      usage,
      modelId: params.model.id,
    },
  };
}

/**
 * Lightweight classifier for `query()` rejections. Keeps the
 * event-stream shape predictable without duplicating the full
 * `core/errors.ts` taxonomy. Backends that want richer
 * classification can pre-throw a `TalonError` subclass; the
 * message-shape match here is conservative.
 */
function classifyChatError(err: unknown): AgentError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let kind: AgentErrorKind = "unknown";
  let retryable = false;
  if (lower.includes("aborted") || lower.includes("abortcontroller")) {
    kind = "aborted";
  } else if (lower.includes("context") && lower.includes("length")) {
    kind = "context_overflow";
  } else if (lower.includes("rate limit") || lower.includes("rate-limit")) {
    kind = "rate_limit";
    retryable = true;
  } else if (lower.includes("overload") || lower.includes("529")) {
    kind = "overload";
    retryable = true;
  } else if (
    lower.includes("session_expired") ||
    lower.includes("session expired")
  ) {
    kind = "session_expired";
  } else if (lower.includes("timed out") || lower.includes("timeout")) {
    kind = "timeout";
    retryable = true;
  } else if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("auth")
  ) {
    kind = "auth";
  }
  return {
    kind,
    message,
    retryable,
    raw: err instanceof Error ? err.stack : undefined,
  };
}
