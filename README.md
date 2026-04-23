# Talon

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-D97706)](https://github.com/anthropics/claude-agent-sdk-typescript)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/dylanneve1/talon/actions/workflows/ci.yml/badge.svg)](https://github.com/dylanneve1/talon/actions/workflows/ci.yml)

Multi-platform agentic AI harness powered by Claude. Runs on **Telegram**, **Teams**, and **Terminal** with full tool access through MCP.

---

## Features

|                       |                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| **Multi-frontend**    | Telegram (Grammy + GramJS userbot), Microsoft Teams (Bot Framework), Terminal with live tool visibility |
| **Claude Agent SDK**  | Streaming responses, extended thinking, adaptive effort, 1M token context, dynamic model discovery      |
| **MCP tools**         | Messaging, media, history, search, web fetch, cron jobs, stickers, file system, admin controls          |
| **Plugins**           | Hot-reloadable plugin system. Built-in: GitHub, MemPalace, Playwright, Brave Search                     |
| **Background agents** | Heartbeat (periodic maintenance) and Dream (memory consolidation + diary)                               |
| **Per-chat settings** | Model, effort level, and pulse toggle per conversation via inline keyboard                              |
| **Model registry**    | Models discovered from the SDK at startup --- new models appear in all pickers automatically            |

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

- [Node.js 22+](https://nodejs.org/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` CLI on PATH)
- Talon runs from a normal source or package install; standalone compiled binaries are not supported.

---

## Architecture

```
index.ts                    Composition root
  |
  +-- core/                 Platform-agnostic engine
  |   +-- models.ts         Model registry (dynamic SDK discovery)
  |   +-- gateway.ts        HTTP bridge for MCP tool calls
  |   +-- dispatcher.ts     Per-chat serial, cross-chat parallel execution
  |   +-- plugin.ts         Plugin loader, registry, hot-reload
  |   +-- heartbeat.ts      Periodic background agent
  |   +-- dream.ts          Memory consolidation agent
  |   +-- pulse.ts          Conversation-aware group engagement
  |   +-- cron.ts           Persistent scheduled jobs
  |   +-- tools/            MCP tool definitions (13 files)
  |
  +-- backend/
  |   +-- claude-sdk/       Claude Agent SDK (modular: handler, stream,
  |   |                     options, state, warm, models, constants)
  |   +-- opencode/         OpenCode SDK alternative backend
  |
  +-- frontend/
  |   +-- telegram/         Grammy bot + GramJS userbot (10 files)
  |   +-- teams/            Bot Framework + Graph API
  |   +-- terminal/         Readline CLI with tool call visibility
  |
  +-- storage/              Sessions, history, chat settings,
  |                         cron jobs, media index, daily logs
  +-- util/                 Config, logging, workspace, paths, time
```

**Dependency rule:** `core/` imports nothing from `frontend/` or `backend/`. Frontends and backends depend on core types, never on each other.

---

## Built-in Plugins

Built-in plugins are **self-healing**: enable them and Talon takes care of installation, version pinning, and freshness checks at startup. No opt-in flags, no manual bootstrap. Every upstream version we ship against is pinned in source and exercised by the CI smoke matrix (Linux/macOS/Windows).

### GitHub

GitHub API access via the official GitHub MCP server.

**Requirements:** Docker installed and running.

```json
{
  "github": {
    "enabled": true,
    "token": "ghp_..."
  }
}
```

On startup Talon pulls the Talon-pinned `ghcr.io/github/github-mcp-server` tag (see `GITHUB_MCP_IMAGE` in `src/plugins/github/heal.ts`). The token is optional — falls back to `gh auth token` output.

### MemPalace

Structured long-term memory with vector search. The agent can store, search, and retrieve memories semantically. Integrates with Dream mode for automatic memory consolidation and personal diary entries.

**Requirements:** Python 3.10+ on PATH (as `python3` on POSIX, `python` on Windows).

```json
{
  "mempalace": {
    "enabled": true
  }
}
```

That's it. On first start Talon creates `~/.talon/mempalace-venv`, pip installs the pinned `mempalace` release (see `MEMPALACE_TARGET` in `src/plugins/mempalace/heal.ts`), and verifies the MCP submodule imports. Subsequent starts re-verify the version and realign to the pin if it drifted.

Optional config:

- `palacePath` — override the default palace directory (`~/.talon/workspace/palace/`).
- `pythonPath` — point at your own Python interpreter. **Supplying this switches Talon to verify-only mode** — we'll probe the installed version but never mutate your environment.
- `entityLanguages` — BCP 47 codes for non-English entity detection.
- `verbose` — enable mempalace's diagnostic diaries.

### Playwright

Headless browser automation via the Playwright MCP server.

**Requirements:** None.

```json
{
  "playwright": {
    "enabled": true,
    "browser": "chromium",
    "headless": true
  }
}
```

On startup Talon verifies the pinned `@playwright/mcp` version (see `PLAYWRIGHT_MCP_VERSION` in `src/plugins/playwright/heal.ts`) and downloads the configured browser binary if missing. Supported browsers: `chromium` (default), `chrome`, `firefox`, `webkit`, `msedge`.

For a remote browser (bring-your-own-CDP, anti-detect browsers, etc.) set `endpoint` or `endpointFile` — Talon skips the local browser install entirely.

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

| Field                      | Default      | Description                                                         |
| -------------------------- | ------------ | ------------------------------------------------------------------- |
| `frontend`                 | `"telegram"` | `"telegram"`, `"terminal"`, `"teams"`, or an array                  |
| `backend`                  | `"claude"`   | `"claude"` or `"opencode"`                                          |
| `botToken`                 | ---          | Telegram bot token                                                  |
| `model`                    | `"default"`  | Default Claude model. Legacy `claude-*` aliases are still accepted. |
| `concurrency`              | `1`          | Max concurrent AI queries (1--20)                                   |
| `pulse`                    | `true`       | Periodic group engagement                                           |
| `heartbeat`                | `false`      | Background maintenance agent                                        |
| `heartbeatIntervalMinutes` | `60`         | Heartbeat interval                                                  |
| `braveApiKey`              | ---          | Brave Search API key                                                |
| `timezone`                 | ---          | IANA timezone (e.g. `"Europe/London"`)                              |
| `plugins`                  | `[]`         | External plugin packages                                            |
| `adminUserId`              | ---          | Telegram user ID for `/admin` commands                              |
| `allowedUsers`             | ---          | Whitelist of Telegram user IDs                                      |
| `apiId` / `apiHash`        | ---          | Telegram API credentials for full message history                   |
| `github`                   | ---          | GitHub plugin config (see above)                                    |
| `mempalace`                | ---          | MemPalace plugin config (see above)                                 |
| `playwright`               | ---          | Playwright plugin config (see above)                                |

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

**Systemd:** `talon.service` included in the repository.

**Health endpoint:** `GET http://localhost:19876/health` returns JSON with uptime, memory, queue depth, active sessions, and last activity timestamp.

**Logging:** Structured JSON via pino to `~/.talon/talon.log`. Rotated on startup when the file exceeds 10MB.

**Resilience:** Dynamic model fallback on overload, session auto-retry on expiry, rate limit handling with backoff, atomic file writes, graceful shutdown with 15-second drain timeout.

---

## Development

```bash
npm run dev              # watch mode
npm test                 # 1300+ tests
npm run test:coverage    # with coverage report
npm run typecheck        # tsc --noEmit
npm run lint             # oxlint
```

---

## License

MIT
