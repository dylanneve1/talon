# Talon

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Backends](https://img.shields.io/badge/backends-Claude_%7C_Kilo_%7C_OpenCode_%7C_Codex_%7C_OpenAI_Agents-D97706)](#backends)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/dylanneve1/talon/actions/workflows/ci.yml/badge.svg)](https://github.com/dylanneve1/talon/actions/workflows/ci.yml)

Multi-platform agentic AI harness. Runs on **Telegram**, **Discord**, **Microsoft Teams**, and the **Terminal**, with a pluggable backend (**Claude Agent SDK**, **Kilo**, **OpenCode**, **Codex**, or **OpenAI Agents**) and full tool access through MCP.

---

## Features

|                       |                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-frontend**    | Telegram (Grammy + GramJS userbot), Discord (discord.js), Microsoft Teams (Bot Framework), Terminal with live tool visibility                |
| **Pluggable backend** | Claude Agent SDK, Kilo, OpenCode, Codex, OpenAI Agents — selectable per-process via `backend` config. Streaming, model fallback, context-overflow recovery. |
| **MCP tools**         | Messaging, media, history, search, web fetch, cron jobs, triggers, stickers, file system, admin controls                                     |
| **Plugins**           | Hot-reloadable plugin system. Built-in: GitHub, MemPalace, Playwright, Brave Search                                                          |
| **Background agents** | Heartbeat (periodic maintenance) and Dream (memory consolidation + diary) — backend-agnostic                                                 |
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
- Talon runs from a normal source or package install; standalone compiled binaries are not supported.

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

### MemPalace

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
  "mempalace": {
    "enabled": true,
    "palacePath": "~/.talon/workspace/palace",
    "pythonPath": "~/.talon/mempalace-venv/bin/python"
  }
}
```

Both paths are optional --- defaults to `~/.talon/workspace/palace/` and the venv Python respectively.

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
| `mempalace`                | ---          | MemPalace plugin config (see above)                                                                                     |
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
