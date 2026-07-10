# Talon

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Backends](https://img.shields.io/badge/backends-Claude_%7C_Kilo_%7C_OpenCode_%7C_Codex_%7C_OpenAI_Agents-D97706)](#backends)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/dylanneve1/talon/actions/workflows/ci.yml/badge.svg)](https://github.com/dylanneve1/talon/actions/workflows/ci.yml)

Multi-platform agentic AI harness. Runs on **Telegram**, **Discord**, **Microsoft Teams**, the **Terminal**, and a **cross-platform Desktop/Mobile companion app** (Flutter), with a pluggable backend (**Claude Agent SDK**, **Kilo**, **OpenCode**, **Codex**, or **OpenAI Agents**) and full tool access through MCP.

---

## Features

|                       |                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-frontend**    | Telegram (Grammy + GramJS userbot), Discord (discord.js), Microsoft Teams (Bot Framework), Terminal with live tool visibility, and a **Desktop/Mobile app** (Flutter) over a local/remote bridge |
| **Pluggable backend** | Claude Agent SDK, Kilo, OpenCode, Codex, OpenAI Agents — selectable per-process via `backend` config. Streaming, model fallback, context-overflow recovery. |
| **MCP tools**         | Messaging, media, history, search, web fetch, cron jobs, triggers, goals, stickers, file system, admin controls                              |
| **Plugins**           | Hot-reloadable plugin system. Built-in: GitHub, MemPalace, Playwright, Brave Search                                                          |
| **Background agents** | Heartbeat (hourly by default — advances goals, proactively messages when something matters) and Dream (memory consolidation + diary)         |
| **Goals**             | Persistent multi-day objectives the agent commits to in chat; every heartbeat run re-reads them, makes progress, and records what it did     |
| **Skills**            | Agent-authored reusable scripts (bash/python/node) — procedures worked out once get saved and replayed locally at zero token cost            |
| **Triggers**          | Self-authored watcher scripts (bash/python/node) that wake the bot when conditions are met                                                   |
| **Per-chat settings** | Model, effort level, and pulse toggle per conversation via inline keyboard                                                                   |
| **Model registry**    | Models discovered from the active backend at startup — new models appear in all pickers automatically                                        |

---

## Quick Start

```bash
git clone https://github.com/dylanneve1/talon.git && cd talon
npm install

# Interactive setup (select frontend, configure tokens, pick model)
npx talon setup

# Start
npx talon start       # configured frontend (daemon mode)
npx talon chat        # terminal chat mode
```

**Prerequisites:**

- [Node.js 24+](https://nodejs.org/)
- Backend-specific:
  - `claude` backend: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` CLI on PATH).
  - `kilo` backend: nothing extra — `@kilocode/sdk` spawns a local server. Free models are accessible without auth; routed models use Kilo's own credentials.
  - `opencode` backend: nothing extra — `@opencode-ai/sdk` spawns a local server.
  - `codex` backend: install the `codex` CLI (`npm i -g @openai/codex`) and authenticate with `codex login`, `CODEX_API_KEY`, `TALON_CODEX_KEY`, or `codexApiKey`. `OPENAI_API_KEY` is used only as a fallback when no Codex login exists.

### Standalone binary

Each release also ships self-contained binaries (no Node.js required) for
Linux and macOS (x64 + arm64) and Windows (x64). Prompts and all native
modules are embedded in the binary.

```bash
# Homebrew (macOS / Linux)
brew install dylanneve1/talon/talon

# Debian / Ubuntu — download the .deb for your arch from the release, then:
sudo apt install ./talon_<version>_amd64.deb     # or _arm64.deb

# Direct download — grab talon-<os>-<arch> from the release, verify, run:
chmod +x talon-linux-x64 && ./talon-linux-x64 --version
# macOS, if Gatekeeper blocks an unsigned binary:
xattr -d com.apple.quarantine ./talon-darwin-arm64
```

Verify a direct download against the release `SHA256SUMS`:
`sha256sum -c SHA256SUMS --ignore-missing`.

> The binary runs the full interactive/agent CLI (`setup`, `start`, `chat`,
> `doctor`, …). Hosting Talon's _own_ MCP server (`talon` as an MCP stdio
> server for another client) still needs the npm/Node install — it spawns a
> `tsx` loader that isn't present in a compiled binary.

---

## Architecture

```
index.ts                    Composition root
  |
  +-- core/                 Platform-agnostic engine
  |   +-- agent-runtime/    Backend capability interfaces, events, stores
  |   +-- models/           Model layer: catalog, per-chat active model,
  |   |                     reasoning-effort vocabulary
  |   +-- prompt/           System-prompt assembly + prompts/system templates
  |   +-- background/       Agents that run without a user message:
  |   |                     heartbeat, dream, pulse, cron, triggers
  |   +-- tools/            MCP tool definitions + spawn/env contract
  |   +-- engine/           Message flow: dispatcher (per-chat serial,
  |   |                     cross-chat parallel), HTTP gateway for MCP
  |   |                     tool calls, backend lifecycle controller
  |   +-- plugin.ts         Plugin loader, registry, hot-reload
  |
  +-- backend/
  |   +-- registry.ts       Bootstrap-decoupled backend lookup
  |   +-- shared/           Cross-backend helpers (stream state, flow violation,
  |   |                     delivery contract, metrics, prompt format,
  |   |                     model retry, system prompt, usage)
  |   +-- remote-server/    Shared infrastructure for agent-server backends
  |   |                     (MCP registration, sessions, providers, lifecycle)
  |   +-- claude-sdk/       Claude Agent SDK (in-process MCP, hooks)
  |   +-- kilo/             Kilo HTTP server backend (streaming via SSE)
  |   +-- opencode/         OpenCode HTTP server backend
  |   +-- codex/            Codex CLI backend (`@openai/codex-sdk`)
  |   +-- openai-agents/    OpenAI Agents SDK backend (Responses API)
  |
  +-- frontend/
  |   +-- shared/           Cross-frontend presentation helpers
  |   +-- telegram/         Grammy bot + GramJS userbot
  |   +-- discord/          discord.js v14
  |   +-- teams/            Bot Framework + Graph API
  |   +-- terminal/         Readline CLI with tool call visibility
  |   +-- desktop/          Client bridge (HTTP + SSE) for the companion app
  |
  +-- storage/              Sessions, history, chat settings,
  |                         cron jobs, media index, daily logs
  +-- util/                 Config, logging, workspace, paths, time
```

**Dependency rule:** `core/` imports nothing from `frontend/` or `backend/`. Frontends and backends depend on core types, never on each other. All five backends (Claude SDK, Kilo, OpenCode, Codex, OpenAI Agents) implement the same `Backend` capability interface from `core/agent-runtime/capabilities.ts`. Kilo and OpenCode additionally share the `remote-server/` infrastructure because they wrap forks of the same upstream HTTP agent server.

**Prompts:** everything the model reads at session start is assembled by `core/prompt/` from the files in `prompts/` — see [prompts/README.md](prompts/README.md) for the assembly order, file ownership (user-editable vs package-owned templates), and the per-backend delivery contracts.

---

## Backends

Select via the `backend` field in `~/.talon/config.json`. All backends implement the same `Backend` capability interface — heartbeat, dream, and chat handlers are backend-agnostic.

| Backend    | `backend` value | Transport                                       | Notes                                                                                                                                                                                                            |
| ---------- | --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude SDK | `"claude"`      | In-process via `@anthropic-ai/claude-agent-sdk` | Requires the `claude` CLI on `PATH`. Hook-based turn termination.                                                                                                                                                |
| Kilo       | `"kilo"`        | Local HTTP server via `@kilocode/sdk`           | SSE-streamed turns. Routes to many model providers via Kilo's auth.                                                                                                                                              |
| OpenCode   | `"opencode"`    | Local HTTP server via `@opencode-ai/sdk`        | SSE-streamed turns; same MCP and session shape as Kilo (upstream fork).                                                                                                                                          |
| Codex      | `"codex"`       | Per-turn subprocess via `@openai/codex-sdk`     | Requires the `codex` CLI from `@openai/codex` and Codex auth (`codex login`, `CODEX_API_KEY`, `TALON_CODEX_KEY`, or `codexApiKey`). MCP servers configured via TOML overrides at thread start. |
| OpenAI Agents | `"openai-agents"` | In-process via `@openai/agents` | Responses API (or any OpenAI-compatible endpoint via `TALON_AGENTS_URL` / `openaiBaseUrl`). Persistent per-chat MCP bundles. |

The Kilo and OpenCode backends share infrastructure (`backend/remote-server/`) since the upstream HTTP API is the same; each backend supplies its own SDK client, port, and delivery suffix. Codex is its own integration on top of the Codex CLI's JSONL event stream.

---

## Desktop & mobile app

The `desktop` frontend turns the daemon into a **client bridge** — a versioned HTTP + Server-Sent-Events JSON API (the _Talon Client Bridge Protocol_, `src/frontend/desktop/protocol.ts`) that any GUI client can speak. The reference client is **[Talon Companion](apps/companion/)**, a single Flutter codebase that runs on **Windows, macOS, Linux, and Android**.

```jsonc
// ~/.talon/config.json
{
  "frontend": "desktop",
  "desktop": { "host": "127.0.0.1", "port": 19880 }
  // For remote (e.g. a phone): "host": "0.0.0.0", "token": "your-secret"
}
```

- **Local (desktop):** the app connects to a Talon on the same machine and launches one if needed (`TALON_FRONTEND_OVERRIDE=desktop`).
- **Remote (mobile/LAN):** point the app at `host:port` + token; the bridge requires `Authorization: Bearer …` (or `?token=` on the SSE stream) whenever a token is set.

The app provides multi-chat history, live streaming with reasoning + tool-call visibility, per-chat model/effort/pulse/reset, and **settings sync** — read and change the daemon's own config (default model, display name, timezone, pulse/heartbeat/dream) and restart it. See [apps/companion/README.md](apps/companion/README.md).

---

## Built-in Plugins

### GitHub

GitHub API access via the official GitHub MCP server. Gives the agent access to repositories, issues, PRs, code search, and more.

**Requirements:** Docker installed and running.

```json
{
  "github": {
    "enabled": true,
    "token": "ghp_..."
  }
}
```

The token is optional --- defaults to the output of `gh auth token` if the GitHub CLI is authenticated.

### Long-term Memory

Talon supports two long-term memory backends, selected via the unified `memory` section:

```json
{
  "memory": {
    "enabled": true,
    "backend": "mempalace"
  }
}
```

Set `"backend"` to `"mempalace"` (local, vector search + knowledge graph) or `"mem0"` ([mem0](https://github.com/mem0ai/mem0) hosted platform or self-hosted server). Backend-specific settings go in a matching `memory.mempalace` / `memory.mem0` sub-object. The legacy top-level `mempalace` section is still honored when `memory` is absent.

#### MemPalace backend

Structured long-term memory with vector search. The agent can store, search, and retrieve memories semantically. Integrates with Dream mode for automatic memory consolidation and personal diary entries.

**Requirements:** Python 3.10+ with the `mempalace` package.

```bash
# Set up a Python environment
python -m venv ~/.talon/mempalace-venv
~/.talon/mempalace-venv/bin/pip install mempalace    # Unix
# or: ~/.talon/mempalace-venv/Scripts/pip install mempalace   # Windows
```

```json
{
  "memory": {
    "enabled": true,
    "backend": "mempalace",
    "mempalace": {
      "palacePath": "~/.talon/workspace/palace",
      "pythonPath": "~/.talon/mempalace-venv/bin/python"
    }
  }
}
```

Both paths are optional --- defaults to `~/.talon/workspace/palace/` and the venv Python respectively.

#### mem0 backend

Long-term memory via [mem0](https://mem0.ai) --- mem0 extracts durable facts from what the agent stores and retrieves them by semantic search. Works against the hosted platform (API key) or a self-hosted mem0 server.

**Requirements:** None --- the `mem0ai` SDK is bundled with Talon.

```json
{
  "memory": {
    "enabled": true,
    "backend": "mem0",
    "mem0": {
      "apiKey": "m0-...",
      "userId": "talon"
    }
  }
}
```

`apiKey` defaults to the `MEM0_API_KEY` env var. For a self-hosted server set `"host"` instead --- the key is then optional. `userId` is the entity id memories are filed under (default `"talon"`).

### Playwright

Headless browser automation via the Playwright MCP server. The agent can browse websites, take screenshots, generate PDFs, fill forms, and scrape content.

**Requirements:** None --- `@playwright/mcp` is bundled with Talon.

```json
{
  "playwright": {
    "enabled": true,
    "browser": "chromium",
    "headless": true
  }
}
```

Supported browsers: `chromium` (default), `chrome`, `firefox`, `webkit`, `msedge`.

### Brave Search

Web search via the Brave Search MCP server. Replaces the built-in WebSearch/WebFetch tools with higher-quality search results.

```json
{
  "braveApiKey": "BSA..."
}
```

Get an API key at [brave.com/search/api](https://brave.com/search/api/).

---

## Custom Plugins

Plugins add MCP tools and gateway actions without modifying core code. SOLID interface --- only `name` is required.

```json
{
  "plugins": [{ "path": "/path/to/my-plugin", "config": { "apiKey": "..." } }]
}
```

```typescript
export default {
  name: "my-plugin",
  version: "1.0.0",
  mcpServerPath: resolve(import.meta.dirname, "tools.ts"),
  validateConfig(config) {
    /* return errors or undefined */
  },
  getEnvVars(config) {
    return { MY_KEY: config.apiKey };
  },
  handleAction(body, chatId) {
    /* gateway action handler */
  },
  getSystemPromptAddition(config) {
    return "## My Plugin\n...";
  },
  init(config) {
    /* one-time setup */
  },
  destroy() {
    /* cleanup */
  },
};
```

Plugins support hot-reload via the `reload_plugins` MCP tool --- no restart required.

---

## CLI

```
talon setup     Interactive setup wizard
talon start     Start as a background daemon
talon stop      Stop the daemon
talon chat      Terminal chat mode (always available)
talon status    Health, sessions, plugins, disk usage
talon config    View or edit configuration
talon logs      Tail structured log file
talon doctor    Validate environment and dependencies
```

---

## Configuration

Config file: `~/.talon/config.json`

| Field                      | Default      | Description                                                                                                             |
| -------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `frontend`                 | `"telegram"` | `"telegram"`, `"discord"`, `"teams"`, `"terminal"`, or an array                                                         |
| `backend`                  | `"claude"`   | `"claude"`, `"kilo"`, `"opencode"`, `"codex"`, or `"openai-agents"`                                                     |
| `botToken`                 | ---          | Telegram bot token                                                                                                      |
| `model`                    | `"default"`  | Default model. Interpretation depends on the active backend.                                                            |
| `codexApiKey`              | ---          | Codex-only OpenAI API key. Prefer this over `openaiApiKey` for Codex API-key auth. `codex login` takes precedence over shared `openaiApiKey`. |
| `concurrency`              | `1`          | Max concurrent AI queries (1--20)                                                                                       |
| `pulse`                    | `true`       | Periodic group engagement                                                                                               |
| `heartbeat`                | `false`      | Background maintenance agent                                                                                            |
| `heartbeatIntervalMinutes` | `60`         | Heartbeat interval                                                                                                      |
| `braveApiKey`              | ---          | Brave Search API key                                                                                                    |
| `timezone`                 | ---          | IANA timezone (e.g. `"Europe/London"`)                                                                                  |
| `plugins`                  | `[]`         | External plugin packages                                                                                                |
| `disabledToolTags`         | ---          | Hide whole tool groups from the model (e.g. `["stickers", "web"]`) — each registered tool costs context tokens per session |
| `disabledTools`            | ---          | Hide individual tools by name (`end_turn` cannot be disabled)                                                           |
| `adminUserId`              | ---          | Telegram user ID for `/admin` commands                                                                                  |
| `allowedUsers`             | ---          | Whitelist of Telegram user IDs                                                                                          |
| `apiId` / `apiHash`        | ---          | Telegram API credentials for full message history                                                                       |
| `github`                   | ---          | GitHub plugin config (see above)                                                                                        |
| `memory`                   | ---          | Long-term memory backend selection: `mempalace` or `mem0` (see above)                                                   |
| `mempalace`                | ---          | Legacy MemPalace plugin config (prefer `memory`)                                                                        |
| `playwright`               | ---          | Playwright plugin config (see above)                                                                                    |

---

## Terminal Mode

```bash
npx talon chat
```

Tool calls shown in real-time with parameters. Streaming phase indicators (thinking / responding / using tools). Per-turn stats: duration, tokens, cache hit rate, tool count.

Commands: `/model`, `/effort`, `/reset`, `/status`, `/help`

---

## Production

**Docker:**

```bash
docker compose up -d
```

**Systemd:** unit file at `packaging/systemd/talon.service` — copy to `/etc/systemd/system/`, set `User=` and `WorkingDirectory=`, then `systemctl enable --now talon`.

**Health endpoint:** `GET http://localhost:19876/health` returns JSON with uptime, memory, queue depth, active sessions, and last activity timestamp.

**Logging:** Structured JSON via pino to `~/.talon/talon.log`. Rotated on startup when the file exceeds 10MB.

**Resilience:** Dynamic model fallback on overload, session auto-retry on expiry, rate limit handling with backoff, atomic file writes, graceful shutdown with 15-second drain timeout.

---

## Development

```bash
npm run dev              # watch mode
npm test                 # 2300+ tests across unit / SDK-stub / MCP-functional / integration tiers
npm run test:coverage    # with coverage report
npm run typecheck        # tsc --noEmit
npm run lint             # oxlint
npm run format           # prettier --write
```

---

## License

MIT
