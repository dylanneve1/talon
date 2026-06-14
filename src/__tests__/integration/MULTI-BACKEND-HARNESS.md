# Multi-backend functional harness — design + status

Goal: drive Talon's **real composition root** + production `dispatcher.execute()`
against a deterministic stub for **every backend transport**, exercising the full
MCP-tool-delivery-through-the-gateway path, with no live model credentials. The
point is to *find issues* by running each backend's real factory/handler/event
code against scripted input.

Each backend connects differently, so each needs its own stub transport.

| backend | transport | stub | status |
|---|---|---|---|
| claude | spawned binary, stdio stream-json (1 long-lived process) | `stub-claude/fake-claude.mjs` | ✅ pre-existing |
| codex | spawned binary, stdio JSONL `ThreadEvent`s (re-spawned per turn) | `stub-codex/fake-codex.mjs` | ✅ done (this PR) |
| opencode | loopback HTTP server + SSE (`@opencode-ai/sdk/v2`) | `stub-remote/` (TODO) | 🚧 specced below |
| kilo | loopback HTTP server + SSE (`@kilocode/sdk/v2`, same wire as opencode) | shares `stub-remote/` | 🚧 specced below |
| openai-agents | OpenAI **Responses API** client (`@openai/agents` SDK) | `stub-openai/` (TODO) | 🚧 specced below |

The shared injection trick: each backend already supports pointing its transport
at a test target —
- claude → `claudeBinary` config
- **codex → `codexBinary` config / `TALON_CODEX_BINARY` (added in this PR)**
- opencode/kilo → `OPENCODE_PORT` / `KILO_PORT` env (the backend probes
  `GET {baseUrl}/global/health` and *reuses* an already-listening server — so a
  fake HTTP server pre-started on that port is adopted; no real `opencode serve`
  spawn)
- openai-agents → `TALON_AGENTS_URL` / `openaiBaseUrl` (OpenAI client `baseURL`)

---

## opencode / kilo fake HTTP server (`stub-remote/`)

Pre-start a Node `http` server on a free port, set `OPENCODE_PORT`/`KILO_PORT` to
it, boot the backend (it adopts the server via the health probe). The client is
`openapi-fetch`-style with `throwOnError: true` — every endpoint returns a 2xx
JSON body that becomes the SDK call's `.data`; non-2xx throws.

### Endpoints the handler exercises (verified against the SDK `sdk.gen.js` URL map)

| SDK call | method + path | fake response |
|---|---|---|
| `global.health` (reuse probe) | `GET /global/health` | `200 {}` |
| `global.event()` | `GET /global/event` (SSE) | `text/event-stream`; keep open; push events |
| `session.create()` | `POST /session` | `{ id: "ses_stub_…" }` (handler reads `data.id`) |
| `session.get()` | `GET /session/{id}` | `200 {}` (existence check) |
| `session.promptAsync()` | `POST /session/{id}/message` | `200`; **side effect**: run the scripted turn (dispatch MCP tools, then push SSE events) |
| `session.messages()` | `GET /session/{id}/message` | `{ data: [ …messages ] }` — last must be `{ role:"assistant", parts:[…], info:{ tokens:{…} } }` |
| `provider.list()` | `GET /provider` | buckets: `{ "<bucket>": [ { id, models: { "<modelID>": { providerID } } } ] }` |
| `mcp.add()` | `POST /mcp` | `200`; record `{name, config:{command,args,env}}` for later dispatch |
| `mcp.disconnect()` | `DELETE /mcp/{name}` (≈) | `200` |
| `session.abort()` | `POST /session/{id}/abort` | `200` |

### SSE event shape (verified in `opencode/handler.ts:599`)

The handler accepts **either** `{payload:{type,properties}}` **or** bare
`{type,properties}` — so emit bare. Frame each as `data: <json>\n\n`. Events the
handler switches on (`remote-server/events.ts`):
- `message.part.delta` — `{properties:{part:{text}}}` streaming text (optional)
- `message.part.updated` — `{properties:{part:{type:"tool", tool, callID, state:{status:"completed", input}}}}` → drives `onToolUse`
- `message.updated` — `{properties:{info:{role:"assistant", sessionID, tokens:{input,output,…}}}}` → usage
- `session.idle` **or** `session.turn.close` — terminator; the handler's `await sseDone` resolves

Minimum viable turn: on promptAsync, push one `message.updated` (usage) then
`session.idle`; have `session.messages` return the final assistant message
(text part for a text reply). For a tool side-effect, also connect a real MCP
client to the recorded `/mcp` server config and `callTool` (routes to the
gateway), and include a tool part.

### Delivery model note (important, may surface an issue)

opencode/kilo use the **text-preferred** contract: plain assistant **text** is
the reply (delivered by Talon's handler via `onTextBlock` from the last
assistant message's text parts), *not* an `end_turn` MCP tool. So the basic
delivery path needs no MCP at all — script a text part. MCP tools are for
genuine side-effects (`react`, `send`). This asymmetry vs claude/codex
(delivery-via-tool) is exactly the kind of structural difference worth a test.

### Model resolution

`config.model = "<modelID>"` (e.g. `stub-model`); `provider.list` must contain a
bucket whose provider `.models["<modelID>"]` exists so `resolveProviderID`
resolves. Discovery otherwise hits the curated/cached catalog.

---

## openai-agents fake Responses API (`stub-openai/`)

Hardest: the `@openai/agents` SDK owns the wire format. Point it at a fake server
via `TALON_AGENTS_URL` + `TALON_AGENTS_KEY` (init forces these into the OpenAI
client `baseURL`/`apiKey`). Needs:
- `GET /models` → `{ data: [ { id, … } ] }` (discovery, `discovery.ts:188`)
- `POST /responses` (default api mode) **streaming SSE** in the Responses API
  event format the SDK parses into `run_item_stream_event`s — the handler
  switches on `event.type === "tool_called"` / `"message_output_created"`
  (`handler.ts:650`). Tool calls carry `{name, callId, arguments}`;
  message output carries `{role:"assistant", content:[{type:"output_text",text}]}`.
- MCP: openai-agents connects MCP servers as **stdio subprocesses** itself
  (`MCPServerStdio`), so tool calls execute in-process via the SDK — the fake
  API only needs to *emit* the `tool_called` event with the right name/args; the
  SDK invokes the real MCP server (→ gateway). Verify the exact Responses-API
  streaming envelope against `@openai/agents` before building; this is the main
  risk.

Tractability order: opencode/kilo (one server, two backends) → openai-agents.
