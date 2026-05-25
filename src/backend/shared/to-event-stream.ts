/**
 * `toEventStream` — convert a callback-driven `query()` handler into
 * a native `AgentEvent` async iterable.
 *
 * Each backend's `handler.ts` already accepts `onStreamDelta`,
 * `onTextBlock`, and `onToolUse` callbacks that fire as the SDK
 * stream produces partial output. Phase 3.x reframes those callbacks
 * as a queued event source: an async generator drains the queue
 * concurrently with the underlying `query()` promise and yields the
 * canonical `AgentEvent` sequence.
 *
 * The result is per-token streaming events (text_delta), per-tool
 * events (tool_call), assistant message blocks (assistant_message),
 * and the standard `run_started → … → usage → completed` envelope.
 * Backends opt in by adding `runChatTurnEvents` to the `QueryBackend`
 * exposed by their factory:
 *
 *   runChatTurnEvents: (params) => toEventStream(handleMessage, params)
 *
 * The agent-runtime adapter (`core/agent-runtime/adapter.ts`) prefers
 * this native stream when present; only backends that haven't opted
 * in fall through to the adapter's synthesised minimal sequence.
 */

import type {
  AgentError,
  AgentErrorKind,
  AgentEvent,
} from "../../core/agent-runtime/events.js";
import type {
  OneShotAgentParams,
  QueryBackend,
  QueryParams,
  QueryResult,
} from "../../core/types.js";

/** Sentinel pushed onto the queue when the query promise settles. */
const SENTINEL = Symbol("toEventStream:sentinel");

type QueueEvent = AgentEvent | typeof SENTINEL;

/**
 * The shape `runChatTurnEvents` accepts on a `QueryBackend` — same
 * as `QueryParams` but without the legacy streaming callbacks (the
 * generator owns the streaming surface).
 */
export type RunChatTurnEventsParams = Omit<
  QueryParams,
  "onStreamDelta" | "onTextBlock" | "onToolUse"
>;

/**
 * Wrap a `QueryBackend['query']`-shaped function into an async
 * iterable of `AgentEvent`s. The generator interleaves callback-
 * driven streaming events with the awaited query result.
 *
 *   run_started → text_delta* → assistant_message* → tool_call* →
 *     usage → completed
 *
 * On error: `run_started → error`.
 *
 * The wrapper synthesises callback wiring on top of the supplied
 * params. Backends that already populate `onStreamDelta` /
 * `onTextBlock` / `onToolUse` should NOT pass them via
 * `runChatTurnEvents` — the queue would race with the caller's
 * own callbacks. The legacy `query()` path remains the place where
 * external callbacks are honoured.
 */
export async function* toEventStream(
  query: (params: QueryParams) => Promise<QueryResult>,
  params: RunChatTurnEventsParams,
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

  // The legacy `onStreamDelta` contract delivers the FULL accumulated
  // text so far, not the new chunk. `AgentEvent.text_delta.text`
  // carries the delta — the pipe consumer (`pipeEventsToCallbacks` /
  // `streamLog` / `event-log-renderer`) re-accumulates. To bridge the
  // two contracts, the wrapper tracks the prior accumulated value
  // and emits only the trailing slice. Backends that already deliver
  // per-token deltas via `onStreamDelta` (Codex's `agent_message`,
  // Claude SDK's stream-events) call the callback with monotonically-
  // growing accumulated strings; the diff is one chunk per call.
  let lastAccumulated = "";

  const legacyParams: QueryParams = {
    ...params,
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

  const queryPromise = query(legacyParams)
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
    modelId: params.model,
  };
  yield { type: "usage", usage };
  yield {
    type: "completed",
    result: {
      text: result.text,
      durationMs: result.durationMs,
      usage,
      modelId: params.model,
    },
  };
}

/**
 * Convenience: bind `toEventStream` to a `QueryBackend` instance's
 * `query` method. Lets a factory expose `runChatTurnEvents` in one
 * line without re-binding `this`.
 */
export function backendChatEvents(backend: QueryBackend) {
  return (params: RunChatTurnEventsParams): AsyncIterable<AgentEvent> =>
    toEventStream(backend.query.bind(backend), params);
}

/**
 * `toOneShotEventStream` — the one-shot counterpart of
 * `toEventStream`. Wraps a `runOneShotAgent`-shaped function into
 * an `AgentEvent` stream by intercepting `appendLog` writes and
 * relaying them as `assistant_message` events.
 *
 * Phase 4 of the architecture unification plan asks heartbeat /
 * dream / trigger consumers to route their log writes through the
 * shared `event-log-renderer.ts` rather than each handler writing
 * its own markdown. This adapter is the bridge: callers continue
 * to build `OneShotAgentParams` the legacy way, but if they want
 * a uniform event stream they hand the result to
 * `streamLog(stream, sink)` instead of supplying `appendLog`
 * directly.
 *
 * The event sequence is deliberately minimal:
 *
 *   run_started → assistant_message* → completed / error
 *
 * No usage event is emitted because `runOneShotAgent` doesn't
 * surface token counters in its current contract. Backends that
 * grow native one-shot event emission (Phase 3.x continued) will
 * supersede this shim.
 */
export type RunOneShotEventsParams = Omit<OneShotAgentParams, "appendLog">;

export async function* toOneShotEventStream(
  runOneShotAgent: (params: OneShotAgentParams) => Promise<void>,
  params: RunOneShotEventsParams,
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

  const legacy: OneShotAgentParams = {
    ...params,
    appendLog: async (text) => {
      // Each appendLog call is rendered as one assistant_message
      // event. The renderer's markdown wrapper handles formatting.
      emit({ type: "assistant_message", text });
    },
  };

  const startedAt = Date.now();
  let error: unknown;

  const runPromise = runOneShotAgent(legacy)
    .catch((err) => {
      error = err;
    })
    .finally(() => {
      emit(SENTINEL);
    });

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
  await runPromise;

  if (error) {
    yield { type: "error", error: classifyChatError(error) };
    return;
  }

  yield {
    type: "completed",
    result: {
      text: "",
      durationMs: Date.now() - startedAt,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      modelId: params.model,
    },
  };
}

/**
 * Lightweight classifier for `query()` rejections. Mirrors the
 * adapter's heuristic — keeps the event-stream shape predictable
 * without duplicating the full `core/errors.ts` taxonomy. Backends
 * that want richer classification can pre-throw a `TalonError`
 * subclass; the message-shape match here is conservative.
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
