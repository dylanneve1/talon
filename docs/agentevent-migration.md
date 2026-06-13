# AgentEvent migration — retiring the legacy callback bridge

## Where we are

Talon's chat-turn streaming currently does a **callbacks → events → callbacks**
round-trip:

```
backend handler (onStreamDelta/onTextBlock/onToolUse, SDK-native)
        │
        │  backend/shared/handler-to-events.ts   (callbacks → AgentEvent)
        ▼
  AsyncIterable<AgentEvent>   ← the canonical contract (ChatBackend.runChatTurn)
        │
        │  core/agent-runtime/event-bridge.ts     (AgentEvent → callbacks)
        ▼
dispatcher (core/engine/dispatcher.ts) → frontend callbacks
        (telegram / discord / teams / terminal)
```

- **Producing side** (`handler-to-events.ts`) is *canonical*, not legacy:
  callback-driven SDKs (Codex, OpenCode, Kilo, OpenAI Agents) wrap their loop
  to emit `AgentEvent`. Claude SDK emits events natively. This stays.
- **Consuming side** (`event-bridge.ts` → `pipeEventsToCallbacks`) is the
  **legacy** half. It exists only because the dispatcher and the four
  frontends still consume the old `StreamingCallbacks` shape
  (`onStreamDelta` / `onTextBlock` / `onToolUse`) instead of reading
  `AgentEvent` directly.

The end state: frontends consume `AgentEvent` directly; the dispatcher hands
the stream through; `event-bridge.ts` is deleted.

## Why this can't be one PR

The bridge has a single caller (`dispatcher.ts:~197`) but its *output* fans
into four frontends' delivery paths, each with its own streaming UX (Telegram
message-edit throttling, Discord typing, Teams cards, terminal print). That's
streaming-critical, user-visible, and per-frontend. A big-bang rewrite is high
risk and hard to review. Stage it.

## What's already locked down

- `agent-runtime/event-bridge.ts` is fully characterized by
  `__tests__/agent-runtime-event-bridge.test.ts` (16 cases: text/thinking
  accumulation, `assistant_message` folding + `deliveryAck`, await-ordering,
  `tool_call` record + non-object→`{}`, terminators, silent events, missing
  callbacks). These tests are the safety net for every stage below.
- The streaming-callback contract is now **single-sourced** as
  `StreamingCallbacks` in `core/types.ts`, reused by both `ExecuteParams` and
  the bridge's `LegacyCallbacks` (this PR). Adding a callback in one place now
  statically obligates the bridge to forward it — no silent drift.

## Staged plan

**Stage 0 — single-source the contract.** ✅ done in this PR.

**Stage 1 — give the dispatcher an event-native entry point.** Add a
dispatcher path that consumes `AgentEvent` and exposes it to the frontend
*alongside* the existing callback path (additive, behind the same
`ExecuteParams`). No frontend changes yet; default behavior unchanged. Land
with tests asserting parity between the event path and the callback path.

**Stage 2 — port frontends one at a time.** For each of terminal → teams →
discord → telegram (simplest first, highest-traffic last), switch its handler
to consume `AgentEvent` directly and drop its `StreamingCallbacks` usage.
One frontend per PR, each independently revertible. Terminal first because it
has the simplest delivery (print) and no throttling state.

**Stage 3 — drop the callback fields.** Once no frontend supplies
`StreamingCallbacks`, remove them from `ExecuteParams`, delete
`pipeEventsToCallbacks` + `LegacyCallbacks` + `event-bridge.ts`, and have the
dispatcher consume the stream directly. `handler-to-events.ts` stays (it's the
canonical producer).

**Stage 4 — collapse the round-trip (optional).** With both ends event-native,
the `accumulate → delta → re-accumulate` dance (`handler-to-events` emits
deltas from accumulated text; the old bridge re-accumulated) can be simplified
where a backend can emit deltas directly.

## Risk notes

- `onTextBlock` is **async** and the bridge serializes it (each block awaited
  before the next event) to keep Telegram's typing-indicator + send ordering
  correct. Any event-native frontend MUST preserve that ordering guarantee —
  port it as an `for await` that awaits block delivery, not fire-and-forget.
- `assistant_message.deliveryAck` is how a backend learns a block was actually
  delivered (resolve) or failed (reject). Event-native frontends must keep
  resolving/rejecting it.
- `tool_call.input` can be a non-plain-object (arrays from some backends); the
  legacy `onToolUse` contract coerces to `{}` with a warning. An event-native
  consumer can preserve the real shape — a latent improvement, but verify each
  frontend's tool-echo rendering first.
