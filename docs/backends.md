# Backends

Talon's `core/` is backend-agnostic. The active model provider is
selected via `backend` in `~/.talon/config.json`, and every backend
implements the same `QueryBackend` interface from
[`src/core/types.ts`](../src/core/types.ts). Heartbeat, dream,
`/model`, `/settings`, `/status`, plugin hot-reload, etc. work
identically against any backend.

## Available backends

| `backend` value | Label     | SDK                              | Transport                                     |
| --------------- | --------- | -------------------------------- | --------------------------------------------- |
| `"claude"`      | Anthropic | `@anthropic-ai/claude-agent-sdk` | Per-query subprocess (the `claude` CLI)       |
| `"kilo"`        | Kilo      | `@kilocode/sdk`                  | Local HTTP server (one process, SSE-streamed) |
| `"opencode"`    | OpenCode  | `@opencode-ai/sdk`               | Local HTTP server (one process, SSE-streamed) |
| `"codex"`       | Codex     | `@openai/codex-sdk`              | Per-turn subprocess (the `codex` CLI)         |

## Shared infrastructure

### `backend/shared/` — backend-agnostic helpers

Every backend uses these:

- `stream-state.ts` — accumulator for text deltas, tool calls,
  delivered-text norms, synthetic-error markers.
- `delivery.ts` — `routeDelivery` decides between
  `tool` / `synthetic-error` / `text-part` / `empty` at end of turn.
- `flow-violation.ts` — detect trailing prose without delivery tool
  call, build the synthetic re-prompt.
- `prompt-format.ts` — `[YYYY-MM-DD HH:MM:SS] [Name] [msg_id:N]`
  prefix on user prompts.
- `system-prompt.ts` — first-turn rebuild + per-backend suffix join.
- `model-retry.ts` — classify retryable errors into reset / fallback /
  bubble decisions.
- `session-name.ts` — first-message → short session title.
- `usage.ts` — cache-hit % + log summariser.

### `backend/remote-server/` — for HTTP-server backends (Kilo, OpenCode)

Kilo and OpenCode both wrap forks of the same upstream HTTP agent
server, so their MCP / session / provider plumbing is shared:

- `client.ts` — narrow `RemoteAgentClient` interface that both
  `OpencodeClient` and `KiloClient` structurally satisfy.
- `state.ts` — per-backend mutable state container.
- `lifecycle.ts` — lazy-spawn + reuse-existing-server probe.
- `mcp.ts` — chat MCP server registration, visibility rotation
  (disconnect rival chat servers before adding the current one — the
  upstream's permission rules only block execution, not visibility),
  plugin server registration.
- `sessions.ts` — `ensureRemoteSession` with the standard permission
  ruleset.
- `session-helpers.ts` — message parsing, usage summary, snapshot
  construction, pending-question rejection.
- `providers.ts` — `resolveProviderID` walking the provider catalog.
- `events.ts` — SSE event processor (`processStreamEvent`,
  `finalizePartsIntoState`).

Codex and Claude SDK don't use this — they wrap different transport
shapes.

## QueryBackend interface

Every backend's `factory.init()` returns one of these from
`core/types.ts`:

```typescript
interface QueryBackend {
  query(params: QueryParams): Promise<QueryResult>;        // required
  warmSession?(chatId: string): Promise<void>;             // Claude-only
  updateSystemPrompt?(prompt: string): void;               // Claude-only
  refreshMcpServers?(chatId: string): Promise<...>;        // Claude-only
  resolveModel?(query: string): Promise<UnifiedModelResolution>;
  getModelInfo?(id: string): Promise<UnifiedModelInfo | undefined>;
  getSettingsPresentation?(activeModel: string, callbackPrefix?: string):
    Promise<{ modelButtons: ModelButton[]; modelDetails: string[] }>;
  getProviders?(): Promise<UnifiedProviderInfo[]>;
  getProviderModels?(providerId: string, page?: number, pageSize?: number):
    Promise<{ models: UnifiedModelInfo[]; total: number }>;
  formatModelError?(query: string, resolution: UnifiedModelResolution): string;
  getSessionSnapshot?(sessionId: string): Promise<...>;     // /status
  listModels?(filter?: "free" | "all"): Promise<...>;
  runOneShotAgent?(params: OneShotAgentParams): Promise<void>;
  evictOrphanSubprocesses?(contextLabel: string): Promise<...>;  // Claude-only
  backendLabel?: string;
}
```

`runOneShotAgent` is what makes heartbeat + dream work across all
backends — each backend's `one-shot.ts` translates the runtime
events into Markdown-flavoured run-log entries.

## Backend-specific notes

### Claude SDK

Spawns the `claude` CLI as a subprocess per turn via
`@anthropic-ai/claude-agent-sdk`. MCP servers are passed in
`Options.mcpServers`; the SDK spawns them inside its subprocess.
Turn termination via `PostToolBatch` hook + `continue: false` returns.

Requires the `claude` CLI on `PATH` and ChatGPT auth (or
`ANTHROPIC_API_KEY`).

### Kilo

Spawns one long-lived `kilo serve` HTTP server (default port 4097)
via `@kilocode/sdk`'s `createKiloServer`. MCP servers registered
via `oc.mcp.add()`. Turns driven by `session.promptAsync` + SSE
events from `oc.global.event()`. Turn termination via
`oc.session.abort()` when a terminator tool fires.

Free-tier models accessible without auth; routed models use Kilo's
own credentials.

### OpenCode

Same shape as Kilo (Kilo is a fork). One long-lived `opencode serve`
HTTP server (default port 4096) via `@opencode-ai/sdk`. Same MCP
wiring, same SSE event loop, same session lifecycle. The two
backends share `backend/remote-server/` infrastructure.

### Codex

Per-turn subprocess via `@openai/codex-sdk`. Each `runStreamed`
spawns the `codex` CLI from `@openai/codex`. MCP servers configured
at thread-creation time via `--config mcp_servers.<name>...` TOML
overrides (Codex doesn't have a runtime `mcp.add` API).

Talon caches the `Codex` instance by chat id so per-chat MCP
isolation works despite the configure-at-startup constraint;
switching chats rebuilds the instance.

Requires the `codex` CLI from `@openai/codex` and Codex auth:
ChatGPT OAuth via `codex login`, or API-key billing via
`CODEX_API_KEY`, `TALON_CODEX_KEY`, or `codexApiKey`. Talon's shared
`OPENAI_API_KEY` / `openaiApiKey` values are last-resort fallbacks only;
they do not override a `codex login` auth file, so other backends can
keep OpenAI-compatible endpoint credentials without hijacking Codex.

## Adding a new backend

1. Create `src/backend/<name>/` with at minimum:
   - `factory.ts` — calls `registerBackend({ id, label, init })`.
   - `handler.ts` — implements `handleMessage(params: QueryParams)`.
   - `index.ts` — barrel.

2. The factory's `init` is called once at startup and returns a
   `QueryBackend` instance. Wire in as many of the optional methods
   as your SDK supports; `core/` falls back gracefully when methods
   are missing.

3. Add `await import("./backend/<name>/factory.js");` to
   `bootstrap.ts`'s factory-loading block.

4. Add `"<name>"` to the `backend` enum in
   `src/util/config.ts` so config validation accepts it.

5. Wire shared infrastructure where it helps. If your backend wraps
   an HTTP server, you probably want to use `remote-server/`. If it
   spawns a subprocess, study the Codex pattern in `backend/codex/`.

6. Update the README's Backends section + this doc.

7. Add tests:
   - Unit tests for backend-specific helpers (`models.ts`,
     `mcp-config.ts`, etc.).
   - A factory wiring test (mock the SDK, assert the returned
     QueryBackend has the expected methods).
   - If you wrap a CLI: a Docker harness under `docker/<name>-test/`
     for live verification.

8. Verify it through the backend-registry-parity test —
   `src/__tests__/backend-registry-parity.test.ts` expects all
   backends to register with non-empty labels + init functions.

## Backend conformance tests

`src/__tests__/backend-conformance.test.ts` exercises the shared
infrastructure (`processStreamEvent`, `finalizePartsIntoState`,
`routeDelivery`) with hand-built event sequences and asserts that
multiple backends produce identical state mutations / route
decisions. This catches drift between backends in the shared layer
without requiring a real upstream server.
