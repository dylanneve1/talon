# `src/core/agent-runtime/`

Single home for the architecture-unification primitives defined in
`docs/talon-architecture-unification-plan.md`. Phases land here
incrementally; each consumer migration converts one production
call site to use the new shape, leaving the rest on the legacy
contract until its own dedicated PR.

## Modules

### `events.ts` (Phase 1)

The canonical `AgentEvent` stream every backend emits or pretends
to emit:

```
run_started | text_delta | assistant_message | reasoning |
tool_call | tool_result | usage | model_swapped | warning |
error | completed
```

Plus `UsageSnapshot`, `AgentError` (with `AgentErrorKind`),
`AgentResult`. Helpers: `emptyUsage`, `addUsage`,
`isAgentEventOf`, `isAgentRunTerminator`.

### `model-ref.ts` (Phase 1)

Typed model identity. `ModelRef = { backend: BackendId, id,
displayName, ... }`. Owns the `BACKEND_IDS` literal — single
source of truth for which backends the typed union can route to.
Helpers: `isBackendId`, `sameModelRef`, `makeBareModelRef`.

### `run-policy.ts` (Phase 1)

`RunPolicy` lifts the loose `contextLabel` string into a real
policy object covering tool surface, delivery mode, timeout,
logging destination, session persistence, permission mode.
`defaultRunPolicyFor("chat" | "heartbeat" | "dream" | "trigger" |
"test")` returns the canonical shape for each run kind.

### `tool-descriptor.ts` (Phase 1)

`ToolDescriptor` + `ToolFilter` + `applyToolFilter`. The canonical
shape `ToolRegistry` stores and Phase 5.x backend renderers
consume.

### `capabilities.ts` (Phase 1)

Split capability interfaces — `ChatBackend`, `BackgroundRunner`,
`ModelCatalog`, `SessionBackend`, `ToolRuntime`, `UsageTelemetry`
— composed onto a single `Backend` object with explicit capability
flags. Replaces the fat optional-methods `QueryBackend` shape for
new code.

### `adapter.ts` (Phase 1)

`adaptQueryBackend(legacy, id, label, opts?)` wraps a legacy
`QueryBackend` as a `Backend`. Synthesises minimal AgentEvent
sequences around `query()` and `runOneShotAgent()`. The bridge
that lets consumers migrate to the new shape before backends are
rewritten.

### `resolver.ts` (Phase 2.1 / 2.3)

`resolveActiveModelRefForChat(chatId, backend, backendId, config)`
returns `{ ref: ModelRef | null, modelId: string | null, source }`.
Wraps the existing string-side `resolveActiveModelForChat`
(`core/active-model.ts`) and enriches the chain's output into a
`ModelRef` via `getModelInfo` → `resolveModel` → bare-ref
fallback. `modelId` is the raw string from the chain so callers
can fall back to the legacy id when `ref` is null but the chain
produced one.

### `registry.ts` (Phase 3 prep)

`getAdaptedBackends` / `adaptOneBackend` / `adaptInstantiatedBackend`
— turn the existing legacy `BackendFactory` registry into
`Backend` composed objects on demand. The dispatcher / heartbeat /
dream Phase 3.x migrations will consume this.

### `tool-registry.ts` (Phase 5 prep)

`ToolRegistry` class storing `ToolDescriptor[]` with atomic
`register` / `registerAll`, `forPolicy(policy)` returning the
filtered subset, and `parseMcpToolId` / `groupToolsByServer`
helpers. Phase 5.x backend renderers will read from this.

### `store.ts` (Phase 6 prep)

`JsonStore<T>` — unified persistence with envelope shape
(`{ schemaVersion, savedAt, data }`), `.bak` fallback on corrupt
primary, `migrate` hook on version mismatch, `validate` hook on
malformed data, and `JsonStoreFs` injection for test isolation.
Phase 6.x will migrate the six existing `src/storage/*` stores
onto this primitive one at a time.

### `contract-tests.ts` (Phase 7)

Backend contract assertions any conforming `Backend` must pass:

- `assertBackendIdentity` — id + label sanity
- `assertChatBackendEmitsRunStarted` — first event
- `assertChatBackendTerminates` — completed/error terminator
- `assertChatBackendEmitsSingleUsage` — exactly one usage event
- `assertCompletedUsageMatchesUsageEvent` — usage agreement
- `assertBackgroundRunnerLifecycle` — started + terminator
- `assertModelCatalogDefaultShape` — ref.backend matches identity
- `assertUsageTelemetryShape` — finite, non-negative counters
- `assertBackendContract` — runs the whole suite, returns the
  list of checks performed

Each throws `ContractViolation` with a descriptive message. Phase
7.x wires these into per-backend test files alongside
SDK-specific quirks.

### `legacy-bridge.ts` (Phase 3 plumbing)

The "render events back into the old shape" half of the Phase 3
bridge. `pipeEventsToCallbacks(stream, callbacks)` consumes an
`AgentEvent` stream and invokes the legacy `QueryParams`
callbacks (`onStreamDelta` / `onTextBlock` / `onToolUse`).
`reduceEventsToResult(stream)` produces a `QueryResult`-shaped
fallback when a backend emits events natively but still needs to
satisfy the legacy `backend.query()` contract during the
migration window. Together with `adapter.ts` (which goes the
other direction) this makes each backend rewrite local.

## Migration cookbook

### To migrate a `resolveActiveModelForChat` caller to ref

1. Import `resolveActiveModelRefForChat` from
   `core/agent-runtime/resolver.js`.
2. Replace `const { model } = await resolveActiveModelForChat(...)`
   with `const { ref, modelId } = await
resolveActiveModelRefForChat(...)`.
3. Use `ref?.displayName ?? modelId ?? "No model selected"` for
   user-facing display.
4. Use `ref?.contextWindow` instead of a separate
   `backend.getModelInfo(model)` call.
5. Use `ref?.id` for backend-facing routing.

Done callers: `/status` (telegram + discord), `/model` main +
browse views.

### To rewrite a backend handler to emit `AgentEvent`s natively (Phase 3.x)

1. In the handler module, define an async generator
   `runChatTurnEvents(params): AsyncIterable<AgentEvent>` that
   yields events as the underlying SDK call streams.
2. Keep the existing `query(params): Promise<QueryResult>` working
   — implement it on top of `runChatTurnEvents` via
   `reduceEventsToResult` plus piping deltas through the legacy
   `onStreamDelta` / `onTextBlock` / `onToolUse` callbacks via
   `pipeEventsToCallbacks`.
3. Add the new method to the backend's `QueryBackend` instance
   on a new optional field (e.g. `runChatTurnEvents?`).
4. Wire the per-backend test file to assert `assertBackendContract`
   against an adapted view of the backend (via
   `adaptInstantiatedBackend`).

Order per the plan: Codex → Claude SDK → OpenAI Agents → Kilo /
OpenCode.

### To migrate a JSON-backed store to `JsonStore<T>` (Phase 6.x)

1. Define the persisted shape `interface MyStoreData { ... }`.
2. Construct `new JsonStore<MyStoreData>({ path, defaultValue,
schemaVersion, validate, migrate })` at module scope.
3. Replace the existing in-memory `Map` + dirty flag + autosave +
   `.bak` fallback + corrupt-read recovery code with calls to
   `store.load()` / `store.update()` / `store.save()`.
4. Update tests to use `JsonStoreFs` injection instead of
   monkey-patching `node:fs` via `HOME` overrides where possible.

Order per the plan: Codex OAuth incompat → media index → cron →
triggers → sessions → chat settings (last, operationally
sensitive).

### To centralise a backend's MCP config (Phase 5.x)

1. Build a `ToolRegistry` instance from the live plugin set at
   bootstrap.
2. In the backend's init/handler, replace the hand-rolled MCP
   config builder with `registry.forPolicy(policy)` then render
   the resulting `ToolDescriptor[]` into the SDK-native config
   shape (Codex TOML, Claude SDK MCP options, etc).
3. Tool collisions surface at registration time via
   `ToolRegistryError`, not at model-call time.

Order per the plan: Codex TOML + Claude SDK MCP config first;
then OpenAI Agents persistent MCP bundle; then any remaining.

## Invariants

- `BACKEND_IDS` in `model-ref.ts` is the source of truth for the
  typed union. The `config.ts` zod enums repeat the same literal
  manually until a later phase imports `BACKEND_IDS` directly.
- `AgentEvent.type` is the ONLY discrimination mechanism. No
  class hierarchy, no `instanceof` checks.
- The adapter's `runChatTurn` yields a minimal event sequence
  (`run_started → assistant_message? → usage → completed`) — Phase
  3.x backends emit richer sequences (per-token streaming, tool
  events).
- Contract assertions throw `ContractViolation` with a descriptive
  message including backend id + contract name + detail. Don't
  rewrite to use plain `Error` — tests assert the message shape.

Refs `docs/talon-architecture-unification-plan.md`.
