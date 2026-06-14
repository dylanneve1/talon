# AgentEvent migration — the legacy callback bridge is gone

## Status: done

Chat-turn streaming is now **event-native end to end**. The backend emits the
canonical `AgentEvent` stream, the dispatcher forwards it verbatim, and each
frontend consumes `AgentEvent`s directly. The `callbacks → events → callbacks`
round-trip and the `event-bridge.ts` translator that powered its second leg
have been deleted.

```
backend handler (onStreamDelta/onTextBlock/onToolUse, SDK-native)
        │
        │  backend/shared/handler-to-events.ts   (callbacks → AgentEvent)
        ▼
  AsyncIterable<AgentEvent>   ← the canonical contract (ChatBackend.runChatTurn)
        │
        │  core/engine/dispatcher.ts   (for-await, forwards each event)
        ▼
   params.onEvent(event)      ← the frontend's event sink
   (telegram / discord / teams / terminal switch on event.type)
```

- **Producing side** (`handler-to-events.ts`) is *canonical*, not legacy:
  callback-driven SDKs (Codex, OpenCode, Kilo, OpenAI Agents) wrap their loop
  to emit `AgentEvent`. Claude SDK emits events natively. This stays.
- **Consuming side** is now event-native. The old `event-bridge.ts`
  (`pipeEventsToCallbacks` + `LegacyCallbacks`) is **deleted**. Frontends no
  longer hand the dispatcher a `StreamingCallbacks` bundle; they hand it one
  `onEvent` sink.

## The contract

`ExecuteParams` (in `core/types.ts`) carries a single streaming sink:

```ts
export type StreamEventSink = {
  onEvent?: (event: AgentEvent) => void | Promise<void>;
};
```

The dispatcher consumes the backend stream and forwards every event in order:

```ts
for await (const event of stream) {
  if (event.type === "completed") agentResult = event.result;
  await params.onEvent?.(event);          // serial: awaited in stream order
  if (event.type === "error") throw new AgentRunError(event.error);
}
```

- `completed` is captured for the dispatcher's `ExecuteResult` return value.
- `error` is forwarded to the sink, then rethrown as `AgentRunError`
  (`core/agent-runtime/events.ts`) so callers' `try/catch` paths — which
  classify via `core/errors.ts` — keep working unchanged.
- Every other event reaches the frontend verbatim.

### What each frontend's `onEvent` must honour

These are the same guarantees the old bridge enforced centrally — now each
frontend owns them (and each is independently revertible):

- **Ordering / back-pressure.** The dispatcher `await`s each `onEvent`. A
  consumer that needs serial delivery (Telegram's typing-indicator + send
  ordering for `assistant_message` blocks) awaits inside `onEvent`. A consumer
  that wants fire-and-forget throttling (Telegram draft edits on `text_delta`)
  simply doesn't await its own work — Telegram fires draft sends with `void`
  to preserve the old non-blocking behaviour.
- **`assistant_message.deliveryAck`.** The consumer MUST `resolve()` on
  successful delivery and `reject(err)` on failure. That's how callback-shaped
  backends learn a block landed (notably Codex oversized-message retries). When
  there is no ack and delivery throws, the consumer rethrows so the turn fails.
- **`tool_call.input` shape.** It's typed `unknown` (backends may emit arrays).
  Frontends that render tool echoes via a `Record<string, unknown>` use the
  shared `toolInputToRecord(name, input)` helper (coerces non-plain-objects to
  `{}` with a warning); consumers that can render the real shape may read
  `event.input` directly.
- **Text accumulation.** `text_delta.text` is the *delta*. A consumer that
  wants the running total (Telegram's draft UI) re-accumulates it itself.

## What's locked down

- `dispatcher.test.ts` pins the event-forwarding contract: events reach
  `onEvent`, a `deliveryAck` reject drives the backend retry path, and an
  `error` terminator is rethrown as `AgentRunError`.
- `integration.test.ts` pins the dispatcher → backend → `onEvent` path and the
  `AgentRunError` classification.
- `handler-to-events.test.ts` still pins the *producing* side (callbacks →
  `AgentEvent`), which is unchanged.

## History

This was scoped as a staged plan — single-source the streaming contract → add
an event-native dispatcher entry point → port frontends one at a time
(terminal → teams → discord → telegram) → delete the bridge → optionally
collapse the accumulate↔delta dance. It then landed in one pass: the contract
change, all four frontend ports, and the bridge deletion together. The
characterization tests that protected each stage now live in
`dispatcher.test.ts` and `integration.test.ts`.
