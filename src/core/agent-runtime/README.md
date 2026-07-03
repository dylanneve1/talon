# `src/core/agent-runtime/`

Single home for the agent-runtime primitives every backend, frontend,
and dispatcher consumer reads through. The architecture-unification
plan landed in seven phases; every phase ships:

| Phase | Scope                                         | Status   |
| ----- | --------------------------------------------- | -------- |
| 1     | Type-only surface (events, ModelRef, …)       | **done** |
| 2     | Active-model resolver yields `{ model, ref }` | **done** |
| 3     | Native `AgentEvent` emission per backend      | **done** |
| 4     | `AgentEventLogRenderer` consumers             | descoped |
| 5     | Centralised tool surface via `ToolRegistry`   | descoped |
| 6     | `JsonStore<T>` over every JSON-backed store   | retired  |
| 7     | Per-backend contract tests                    | **done** |

Phases 4 and 5 are descoped: the `AgentEventLogRenderer` and
`ToolRegistry` infrastructure was implemented but no production
consumer wired through. Heartbeat / dream still prefer their direct
`appendLog` markdown for log files; backend MCP configs continue to
build from `getPluginMcpServers(...)` directly. Both were removed
to keep the runtime surface honest — they can come back when a
real consumer exists.

The fat-optional `QueryBackend` shape is gone; every backend factory
builds and returns a composed `Backend` via `composeBackend({...})`.
Consumers read through capability slots — `backend.chat?.runChatTurn`,
`backend.models?.resolveModel`, `backend.background?.runOneShotAgent`,
etc.

## Modules

### `events.ts`

The canonical `AgentEvent` stream every backend emits:

```
run_started | text_delta | assistant_message | reasoning |
tool_call | tool_result | usage | model_swapped | warning |
error | completed
```

Plus `UsageSnapshot`, `AgentError` (with `AgentErrorKind`),
`AgentResult`. Helpers: `emptyUsage`, `addUsage`, `isAgentEventOf`,
`isAgentRunTerminator`.

### `model-ref.ts`

Typed model identity. `ModelRef = { backend: BackendId, id,
displayName, ... }`. Owns the `BACKEND_IDS` literal — single source of
truth for which backends the typed union can route to. Helpers:
`isBackendId`, `sameModelRef`, `makeBareModelRef`.

### `capabilities.ts`

Split capability interfaces — `ChatBackend`, `BackgroundRunner`,
`ModelCatalog`, `SessionBackend`, `ToolRuntime`, `UsageTelemetry`,
`SystemControl` — composed onto a single `Backend` object via
`composeBackend({...})`. A capability is present iff its slot is: an
absent / `undefined` slot is the single source of truth for "this
backend doesn't support that" — there's no mirrored flag record to
drift out of sync.

### `store.ts` (retired)

`JsonStore<T>` served as the unified JSON-file persistence primitive
until every consumer (cron, triggers, codex oauth-incompat) migrated
onto the SQLite layer in `src/storage/` (typed tables or the `kv`
singleton store). Legacy files import once at boot via
`storage/legacy-import.ts` and are renamed `*.imported`.

### `contract-tests.ts`

Backend contract assertions any conforming `Backend` must pass:

- `assertBackendIdentity` — id + label sanity
- `assertChatBackendEmitsRunStarted` — first event
- `assertChatBackendTerminates` — completed/error terminator
- `assertChatBackendEmitsSingleUsage` — exactly one usage event
- `assertCompletedUsageMatchesUsageEvent` — usage agreement
- `assertBackgroundRunnerLifecycle` — runOneShotAgent settles
- `assertModelCatalogDefaultShape` — ref.backend matches identity
- `assertUsageTelemetryShape` — finite, non-negative counters
- `assertBackendContract` — runs the whole suite, returns the list of
  checks performed

Each throws `ContractViolation` with a descriptive message.

### `event-bridge.ts`

The bridge between the canonical `AgentEvent` stream and the
callback-shaped consumer contract the dispatcher uses upstream of the
backend. `pipeEventsToCallbacks(stream, callbacks)` consumes an
`AgentEvent` stream and invokes the supplied callbacks (`onStreamDelta`
/ `onTextBlock` / `onToolUse`), returns the final `AgentResult`, and
throws `BridgedAgentError` carrying the original `AgentError` if the
stream terminates with an error event.

## Migration cookbook

### Adding a new backend

1. Implement an SDK-specific `handleMessage(params: QueryParams):
Promise<QueryResult>` in `backend/<id>/handler.ts`. The handler
   may drive its SDK through the `onStreamDelta` / `onTextBlock` /
   `onToolUse` callbacks — `handlerToEvents` wraps them into events.
2. In `backend/<id>/factory.ts`, build each capability slot:

   ```ts
   const chat: ChatBackend = {
     runChatTurn: (params) => handlerToEvents(handleMessage, params),
   };
   const background: BackgroundRunner = {
     runOneShotAgent: (p) => runOneShotAgent(p),
     evictOrphanSubprocesses: (label) => evictOrphans(label),
   };
   const models: ModelCatalog = {
     // Required core (resolution) — the dispatcher + active-model
     // resolver depend on these:
     resolveModelInfo: (q) => ...,   // UnifiedModelResolution
     getDefaultModelId: () => ...,   // canonical id | null | undefined
     getRawModelInfo: (id) => ...,   // UnifiedModelInfo | undefined
     // Optional picker / browse surface — omit for a fixed-model
     // backend; the /model picker degrades gracefully when absent:
     getSettingsPresentation: (active, opts) => ...,
     getProviders: () => ...,
     getProviderModels: (provider, page, size) => ...,
     listModels: (f) => ...,
     formatModelError: (q, resolution) => ...,
   };
   ```

3. Compose: `const backend = composeBackend({ id, label,
cacheMetrics, chat, background, models, sessions, tools, usage,
control });`
4. Register: `registerBackend({ id, label, init: async (cfg, ctx) =>
({ backend, cleanup }) })`.

### Reading the resolved model for a chat

`resolveActiveModelForChat(chatId, backend, backendId, config)`
returns `{ model: string | null, ref: ModelRef | null, source }`:

- `model` is the raw id from the 5-step chain (per-chat override →
  backend canonical → operator default → legacy global → null).
- `ref` enriches that id with `displayName`, `contextWindow`,
  `effortLevels`, `cacheSupport`, etc. — `null` when `model` is
  null or `backendId` isn't a known `BackendId`.
- `source` carries the chain step that produced the model, useful
  for toast wording and stale-slot cleanup.

Convenience wrappers:

- `getActiveModelForChat(...)` → `model`
- `getActiveModelRefForChat(...)` → `ref`

### Adding a new store

New structured state goes in the SQLite layer — see the layering doc
in `src/storage/db.ts` (sql/<store>.sql → repositories/<store>-repo.ts
→ storage/<store>.ts). Tiny singleton blobs can use `storage/kv.ts`.

## Invariants

- `BACKEND_IDS` in `model-ref.ts` is the source of truth for the typed
  union. `src/util/config.ts` zod enums are wired to the same literal.
- `AgentEvent.type` is the ONLY discrimination mechanism. No class
  hierarchy, no `instanceof` checks.
- Every `ChatBackend.runChatTurn` stream terminates with `completed`
  or `error`. Backends emit `run_started` first.
- Contract assertions throw `ContractViolation` with a descriptive
  message including backend id + contract name + detail. Don't
  rewrite to use plain `Error` — tests assert the message shape.
