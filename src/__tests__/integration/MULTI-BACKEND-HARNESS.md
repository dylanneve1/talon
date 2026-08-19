# Multi-backend functional harness

Drives Talon's **real composition root** + production `dispatcher.execute()`
against a deterministic stub for **every backend transport**, exercising the
full MCP-tool-delivery-through-the-gateway path, with no live model credentials.
The point is to _find issues_ by running each backend's real
factory/handler/event code against scripted input — and to keep that cheap to
extend as backends are added.

## Status: all 5 backends covered

| backend       | transport                                                      | stub                                            | delivery                        |
| ------------- | -------------------------------------------------------------- | ----------------------------------------------- | ------------------------------- |
| claude        | spawned binary, stdio stream-json (1 long-lived process)       | `stub-claude/` (pre-existing, separate harness) | `end_turn` tool                 |
| codex         | spawned binary, stdio JSONL `ThreadEvent`s (per-turn re-spawn) | `stub-codex/fake-codex.mjs`                     | `end_turn` tool                 |
| opencode      | loopback HTTP + SSE (`@opencode-ai/sdk/v2`)                    | `stub-remote/fake-remote-server.ts`             | plain **text** (text-preferred) |
| kilo          | loopback HTTP + SSE (`@kilocode/sdk/v2`, opencode fork)        | shares `stub-remote/`                           | plain **text**                  |
| openai-agents | OpenAI `chat_completions` client (`@openai/agents`)            | `stub-openai/fake-openai-server.ts`             | `end_turn` tool                 |

## Architecture

```
stub-harness/
  types.ts              StubBackendAdapter<Turn>, StubTurnResult, TurnContext
  harness.ts            createStubHarness(adapter) → { runTurn, recording, teardown }
  adapters/
    codex.ts            codexAdapter()
    remote.ts           remoteAdapter({ id, portEnv })   ← opencode + kilo
    openai-agents.ts    openaiAgentsAdapter()
stub-codex/             fake codex binary + protocol/helpers
stub-remote/            fake opencode/kilo HTTP+SSE server
stub-openai/            fake OpenAI chat_completions server
*-functional.test.ts    one file per backend, ~10 lines of setup each
```

`createStubHarness(adapter)` owns everything backend-independent: booting the
composition root once (lazily, on first turn), a live `Gateway` + recording
action handler (so MCP tool calls route through the real
SDK→MCP→bridge→gateway chain), the frontend seam, per-turn temp dirs, and
driving `dispatcher.execute()`. A `StubBackendAdapter` supplies only the
transport-specific stub:

```ts
interface StubBackendAdapter<Turn> {
  readonly id: BackendId;
  readonly model: string;
  prepare?(): Promise<void> | void; // start fake server / set stub env
  configOverrides?(): Partial<TalonConfig>; // binary path, base URL, …
  applyTurn(turn, ctx): void | Promise<void>; // script the next dispatcher turn
  afterTurn?(ctx): void;
  collectExtras?(ctx): Record<string, unknown>;
  teardown?(): Promise<void> | void;
}
```

**Adding a backend = adding one adapter** (+ a fake server if its transport is
new). No harness changes. The adapter's `prepare()` runs BEFORE
`initBackendAndDispatcher`, which matters because backend factory modules read
their port/auth env at import time and that import happens inside the
composition root — so e.g. the remote adapter starts its fake server on a
**dynamic** port and assigns it into `OPENCODE_PORT`/`KILO_PORT` there (no fixed
ports, no `vi.hoisted`).

## How each transport is stubbed

- **codex** — fake `codex` binary: reads the prompt from stdin, emits scripted
  `thread.started → turn.started → item.completed(agent_message|mcp_tool_call) →
turn.completed` JSONL, exits 0. Reconstructs the MCP server map from the
  codex-sdk's flattened `--config mcp_servers.*` TOML argv and dispatches tool
  calls through a real MCP client → gateway. A counter file tracks "which turn"
  across the per-turn re-spawns. Pointed at via `codexBinary` / `TALON_CODEX_BINARY`.
- **opencode / kilo** — in-process fake HTTP server adopted via the backend's
  `/global/health` reuse probe. Serves session/provider/mcp endpoints + a
  `/global/event` SSE stream; pushes scripted events
  (`message.part.updated` for tools, `message.updated` for usage, `session.idle`
  to close the turn) and dispatches MCP side-effects through the gateway. One
  server + one adapter (parameterized by id + port env) covers both backends.
- **openai-agents** — fake OpenAI `chat_completions` server. The SDK runs MCP
  tools as its own stdio subprocesses, so the fake only streams the model's
  output and resolves the real (SDK-mangled, e.g. `mcp_telegram_tools__end_turn`)
  function name from the request's `tools` catalog — the script just says
  `end_turn`. A per-response counter walks the multi-request agentic loop.

## Wire-level facts the build surfaced (else a naive stub silently hangs)

- **codex** had no executable-path override like claude's `claudeBinary` →
  added `codexBinary` config + `TALON_CODEX_BINARY` → codex-sdk
  `codexPathOverride` (the one production change in this work; additive + guarded).
- **opencode/kilo**: promptAsync posts to `/session/{id}/prompt_async` (not
  `/message`); `mcp.add` sends `config.command` as a full `[exe, ...args]`
  **array** + `config.environment` (not `env`); disconnect is
  `POST /mcp/{name}/disconnect`; chat MCP servers remain registered concurrently
  and production scopes their visibility with prompt `tools` overrides; the SSE
  subscribe is fired-but-not-awaited just before promptAsync (the fake waits on
  the actual connect, event-driven, before emitting).
- **openai-agents** is tool-preferred (delivers via `end_turn`, not text — plain
  text triggers the flow-violation re-prompt loop), and MCP function names are
  SDK-generated (resolve them from the request, don't hardcode).
- **Delivery split now under test:** claude/codex/openai-agents deliver via the
  `end_turn` **tool**; opencode/kilo deliver via plain assistant **text**.
