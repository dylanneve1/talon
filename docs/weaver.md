# The Weaver — unified thread/chat manager

> Status: **implemented** (feat/weaver-thread-manager). Steps 1–5 landed
> incrementally and behavior-preserving; the Weaver/Loom/Thread now own all
> per-chat live state. Step 5's write paths are intentionally still routed
> through the session store directly (see below).

## Why

Per-chat conversation state is currently smeared across four modules with four
separate `Map<chatId, …>` registries and no single owner:

| Concern | Lives in today | Registry |
| --- | --- | --- |
| Turn serialization (per-chat FIFO, cross-chat parallel) | `core/engine/dispatcher.ts` | `chatChains` |
| Backend binding / per-chat override | `core/engine/backend-controller/` | `bindings` (`chat:<id>` holder) |
| Session resume handle | `storage/sessions.ts` | session rows |
| Context refcount / messages-sent | `core/engine/gateway.ts` | `ChatContext` |

Adding a frontend (Discord, Teams) or reasoning about "what is the live state of
chat X" means touching all four. Config drift (chat says model A, backend
silently runs B) is hard to surface because nothing owns the resolved binding.

## The model

One concept owns all per-chat state: a **Thread**. The **Loom** is the registry
of live Threads. The **Weaver** is the orchestrator that runs turns over them.

```
Weaver            — orchestrator. Public API the engine/frontends call.
 └─ Loom          — registry of live Threads (get/create/evict/persist).
     └─ Thread    — ONE chat's live state:
          warp    — durable per-thread setup: backend binding (chatHolder),
                    resolved model ref, session handle, system/context policy.
          weft    — transient per-turn data: the message being woven now.
          shuttle — the turn runner: carries the weft across the warp to the
                    backend and streams events back (today's dispatcher.run).
```

One-liner: **the Weaver runs the Loom of Threads; for each turn the Shuttle
carries the weft across the warp.**

### Vocabulary → code mapping

- `Weaver` — replaces the free functions in `dispatcher.ts` as the entry point
  (`weaver.runTurn(params)`), and owns turn lifecycle.
- `Loom` — `Map<chatId, Thread>`; absorbs `chatChains`. `loom.thread(chatId)`
  lazily creates a Thread and is the single source of "is this chat live".
- `Thread` — holds: the per-chat promise chain (serialization), the execution
  context (refcount + per-turn message counter, absorbing `ChatContext`), the
  resolved `warp`, and a handle to its session.
- `Thread.warp` — resolved at bind time and **logged on drift**, so
  configured-vs-running divergence is explicit state, not a silent fallback.
- `Thread.session` — a chat-scoped read handle over `storage/sessions.ts`; the
  store stays the source of truth.
- `Thread.weft` — the `ExecuteParams` for the current turn.
- `Shuttle` — the inner `executeInner` body: typing, stream consume, ack
  settlement, usage capture.

## Non-goals

- No change to the backend pool/rebind logic — Thread *references* a binding via
  the existing `chatHolder`/`rebindChat` API; it does not reimplement pooling.
- No protocol/wire changes to the gateway HTTP bridge.
- No behavior change: per-chat serial + cross-chat parallel stays identical;
  the null-model guard, model-override path, and deliveryAck settlement are
  preserved verbatim.
- Session **writes** (`setSessionId`/`recordUsage`/…) still run through the
  store directly — backends own those callsites. `Thread.session` is a read
  handle for now; writes migrate onto it as callsites move under the Weaver.

## Incremental plan

1. ✅ **Scaffold** `src/core/weaver/` with `Thread`, `Loom`, `Weaver` types +
   barrel. Pure types + the registry.
2. ✅ **Move serialization**: lift `chatChains` into `Loom`/`Thread`. Dispatcher
   `execute()` is `weaver.runTurn()` delegating to `Thread.enqueue()`; per-chat
   FIFO / cross-chat parallel preserved.
3. ✅ **Absorb context refcount**: the gateway's `ChatContext` (refCount,
   messagesSent, numeric/string ids) now lives on the Thread. The Loom carries a
   numeric secondary index; the gateway delegates and owns no per-chat state.
4. ✅ **Bind the warp**: each Thread records its resolved model + backend id per
   turn and logs drift; `weaver.snapshot()` / `dispatcher.snapshot()` surface
   the live warp for `/status`, drift detection, and remote frontends.
5. ✅ **Session handle**: `Thread.session` gives chat-scoped access to the
   session store (read handle this PR; see Non-goals).

Each step is its own commit, independently reviewable, behavior-preserving.

## Testing

- Existing dispatcher tests exercise the serialization invariant unchanged.
- `weaver.test.ts`: Loom lazily creates one Thread per chat, evicts idle
  Threads, `runTurn` preserves FIFO-within / parallel-across, the execution
  context brackets a turn (per-turn message-count reset, ref-counting, numeric
  index, Teams string-id resolution), `bindWarp` reports drift, and `snapshot()`
  reports the warp + session summary per live Thread.
- `gateway-context.test.ts` / `gateway-http.test.ts` cover the gateway's
  delegation to the Loom (acquire/release/message-count/routing) unchanged.
