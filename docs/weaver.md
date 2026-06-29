# The Weaver — unified thread/chat manager

> Status: **proposed** (feat/weaver-thread-manager). Incremental, behavior-preserving.

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
- `Thread` — holds: the per-chat promise chain (serialization), a handle to its
  backend binding (delegates to backend-controller, does **not** duplicate the
  pool), its session handle, and the context refcount (absorbs `ChatContext`).
- `Thread.warp` — resolved at bind time and **logged**, so configured-vs-running
  divergence is explicit state, not a silent fallback.
- `Thread.weft` — the `ExecuteParams` for the current turn.
- `Shuttle` — the inner `executeInner` body: typing, stream consume, ack
  settlement, usage capture.

## Non-goals (this PR)

- No change to the backend pool/rebind logic — Thread *references* a binding via
  the existing `chatHolder`/`rebindChat` API; it does not reimplement pooling.
- No protocol/wire changes to the gateway HTTP bridge.
- No behavior change: per-chat serial + cross-chat parallel stays identical;
  the null-model guard, model-override path, and deliveryAck settlement are
  preserved verbatim.

## Incremental plan

1. **Scaffold** `src/core/weaver/` with `Thread`, `Loom`, `Weaver` types +
   barrel. Pure types + the registry, no behavior yet.
2. **Move serialization**: lift `chatChains` into `Loom`/`Thread`. Dispatcher
   `execute()` becomes `weaver.runTurn()` delegating to `Thread.enqueue()`.
   Tests for per-chat FIFO / cross-chat parallel must stay green.
3. **Absorb context refcount**: fold the gateway's `ChatContext` into `Thread`
   (refCount, messagesSent, stringId). Gateway asks the Loom.
4. **Bind the warp**: Thread holds its resolved model ref + backend id; surface
   `weaver.snapshot()` for `/status` and drift detection.
5. **Session handle** (follow-up PR): Thread owns its session resume handle so
   `storage/sessions.ts` becomes Thread-scoped persistence.

Each step is its own commit, independently reviewable, behavior-preserving.

## Testing

- Reuse existing dispatcher tests; they exercise the serialization invariant.
- Add `weaver.test.ts`: Loom lazily creates one Thread per chat, evicts idle
  Threads, and `runTurn` preserves FIFO-within / parallel-across.
- `snapshot()` reports the resolved warp (model/backend) per live Thread.
