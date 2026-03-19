# Talon

[![CI](https://github.com/dylanneve1/talon/actions/workflows/ci.yml/badge.svg)](https://github.com/dylanneve1/talon/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-D97706)](https://github.com/anthropics/claude-agent-sdk-typescript)
[![Tests](https://img.shields.io/badge/tests-322_passing-brightgreen)](https://github.com/dylanneve1/talon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Multi-platform agentic AI harness powered by Claude. Runs on Telegram, Teams, and Terminal with full tool access through MCP.

## Features

- **Multi-frontend** — Telegram (Grammy), Teams (Bot Framework), Terminal (readline)
- **Claude Agent SDK** — streaming responses, extended thinking, 1M context sessions
- **31 MCP tools** — messaging, media, history, search, web, cron jobs, file system
- **Plugin system** — extend with external tool packages (keeps core OSS-clean)
- **Cron jobs** — persistent recurring tasks with full tool access
- **Pulse** — periodic conversation-aware engagement in group chats
- **Per-chat settings** — model, effort level, pulse toggle per conversation

## Quick Start

```bash
git clone https://github.com/dylanneve1/talon.git && cd talon
npm install

# Interactive setup (select frontend, configure tokens)
npx talon setup

# Start
npx talon start       # configured frontend (Telegram/Terminal)
npx talon chat        # terminal chat mode
```

Requires [Node.js 22+](https://nodejs.org/) and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

## Architecture

```
index.ts (Composition Root)
├── core/               Platform-agnostic core
│   ├── gateway.ts      HTTP bridge for MCP tool calls
│   ├── dispatcher.ts   Query queue + lifecycle
│   ├── plugin.ts       Plugin loader + registry
│   ├── pulse.ts        Periodic engagement
│   └── cron.ts         Persistent scheduled jobs
├── backend/
│   ├── claude-sdk/     Claude Agent SDK + MCP subprocess
│   └── opencode/       OpenCode SDK alternative
├── frontend/
│   ├── telegram/       Grammy + GramJS userbot
│   ├── teams/          Bot Framework
│   └── terminal/       Readline CLI with tool call visibility
└── storage/            Sessions, history, settings, cron, media
```

## Plugin System

Plugins add MCP tools and gateway actions without modifying core code. SOLID interface — only `name` is required, everything else is optional.

```json
{
  "plugins": [
    { "path": "/path/to/my-plugin", "config": { "apiKey": "..." } }
  ]
}
```

```typescript
export default {
  name: "my-plugin",
  version: "1.0.0",
  mcpServerPath: resolve(import.meta.dirname, "tools.ts"),
  validateConfig(config) { /* return errors or undefined */ },
  getEnvVars(config) { return { MY_KEY: config.apiKey }; },
  handleAction(body, chatId) { /* gateway action handler */ },
  getSystemPromptAddition(config) { return "## My Plugin\n..."; },
  init(config) { /* one-time setup */ },
  destroy() { /* cleanup */ },
};
```

## CLI

```
talon setup     Interactive setup wizard (multi-select frontends)
talon start     Start the configured frontend
talon chat      Terminal chat mode (always available)
talon status    Health, sessions, and plugin status
talon config    View/edit configuration
talon logs      Tail structured log file
talon doctor    Validate environment
```

## Configuration

`workspace/talon.json`:

| Field | Default | Description |
|-------|---------|-------------|
| `frontend` | `"telegram"` | `"telegram"`, `"terminal"`, or both |
| `botToken` | — | Telegram bot token (required for Telegram) |
| `model` | `"claude-sonnet-4-6"` | Default model |
| `concurrency` | `1` | Max concurrent AI queries |
| `pulse` | `true` | Periodic group engagement |
| `plugins` | `[]` | External plugin packages |
| `adminUserId` | — | Telegram user ID for /admin |
| `apiId` / `apiHash` | — | Telegram API for full history |

## Terminal Mode

```bash
talon chat    # interactive terminal chat
```

Tool calls shown in real-time with parameters. Streaming phase indicators (thinking/responding/using tools). Per-turn stats (duration, tokens, cache hit, tool count).

## Production

- **Docker**: `docker compose up -d`
- **Systemd**: `talon.service` included
- **Health**: `GET http://localhost:19876/health` — JSON with uptime, memory, queue, sessions
- **Logging**: Structured JSON via pino to `workspace/talon.log`
- **Resilience**: Model fallback, session auto-retry, rate limiting, atomic writes, graceful shutdown

## Development

```bash
npm run dev              # watch mode
npm test                 # 322 tests
npm run test:coverage    # with coverage
npm run typecheck        # tsc --noEmit
npm run lint             # oxlint
```

## License

MIT
