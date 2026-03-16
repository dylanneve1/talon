# 🦅 Talon

Claude-powered Telegram bot with 29 tools, streaming, cron jobs, and group awareness.

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-D97706)](https://github.com/anthropics/claude-agent-sdk-typescript)
[![Tests](https://img.shields.io/badge/Tests-293_passing-brightgreen)]()

## Quick Start

```bash
git clone https://github.com/dylanneve1/talon.git && cd talon
npm install
npm start
```

On first run, Talon creates `workspace/talon.json` with defaults. Add your bot token from [@BotFather](https://t.me/BotFather), then restart.

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated.

## What It Does

Talon connects Telegram to Claude via the Agent SDK. Claude has full tool access — it can send messages, react, create files, search history, manage cron jobs, and more. All through 29 MCP tools.

**Input**: Text, photos, documents, voice, audio, videos, GIFs, stickers, video notes, contacts, locations, forwards, replies, button presses.

**Output**: Text with Markdown→HTML formatting, photos, files, stickers, polls, inline keyboards, reactions, scheduled messages, dice, locations, contacts.

**AI Features**: Streaming responses, persistent sessions (1M context), session auto-resume across restarts, thinking indicators, per-chat model/effort settings, cron jobs, pulse engagement.

## Configuration

All config lives in `workspace/talon.json`:

```json
{
  "botToken": "your-bot-token-here",
  "model": "claude-sonnet-4-6",
  "concurrency": 1,
  "pulse": true,
  "pulseIntervalMs": 300000,
  "adminUserId": 0,
  "maxMessageLength": 4000
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `botToken` | — | Telegram bot token (required) |
| `model` | `claude-sonnet-4-6` | Claude model (sonnet, opus, haiku) |
| `concurrency` | `1` | Max concurrent AI queries |
| `pulse` | `true` | Enable periodic group engagement |
| `pulseIntervalMs` | `300000` | Pulse check interval (5 min) |
| `adminUserId` | `0` | Telegram user ID for /admin commands |
| `apiId` / `apiHash` | — | Telegram API credentials for full history |
| `maxMessageLength` | `4000` | Max chars before message splitting |

Environment variables (`TALON_BOT_TOKEN`, etc.) work as fallback.

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Introduction |
| `/settings` | Interactive settings panel |
| `/status` | Session info, usage, context, cache stats |
| `/ping` | Health check with latency |
| `/model` | Show or change model |
| `/effort` | Set thinking effort |
| `/pulse` | Toggle periodic engagement |
| `/reset` | Clear session |
| `/help` | All commands |
| `/admin` | Admin panel (stats, errors, chats, broadcast, logs, cron) |

## Architecture

```
index.ts                    ← composition root (platform-agnostic)
├── core/                   ← dispatcher, errors, types, pulse, cron
│   ├── dispatcher.ts       ← p-queue concurrency, bridge lifecycle
│   ├── errors.ts           ← TalonError classification
│   └── pulse.ts / cron.ts  ← scheduled execution
├── backend/claude-sdk/     ← Agent SDK wrapper + MCP tools
│   ├── index.ts            ← session management, streaming
│   └── tools.ts            ← 29 MCP tools (subprocess)
├── frontend/telegram/      ← grammY bot + bridge
│   ├── index.ts            ← factory (createTelegramFrontend)
│   ├── handlers.ts         ← message routing, streaming
│   ├── bridge/             ← HTTP bridge for MCP tool execution
│   └── commands.ts         ← slash command handlers
├── storage/                ← atomic JSON persistence
│   ├── sessions.ts         ← session state + cost tracking
│   ├── history.ts          ← message buffer (persisted)
│   └── chat-settings.ts    ← per-chat model/effort/pulse
└── util/                   ← config, pino logging, watchdog
```

**Key design**: Core knows nothing about Telegram or Claude. Frontend and backend are swappable. All dependencies injected at startup.

## Terminal Chat

```bash
talon chat           # interactive terminal chat with Claude
```

Same backend, same sessions, same tools — just a different I/O surface. Animated spinner, emoji reactions, `/reset` and `/help` commands.

## Production

**Docker**:
```bash
docker compose up -d
```

**Systemd**: Copy `talon.service` to `/etc/systemd/system/`, enable, start.

**Health endpoint**: `GET http://localhost:19876/health` — JSON with uptime, memory, queue, sessions, errors.

**Logging**: Structured JSON via pino to `workspace/talon.log` + console.

**Resilience**: Model fallback (Opus → Sonnet on overload), session auto-retry, per-user rate limiting (15/min), API throttling, atomic writes, 15s shutdown timeout with queue drain, bot token circuit breaker.

## Development

```bash
npm run dev          # watch mode
npm test             # 297 tests
npm run test:coverage
npm run typecheck    # tsc --noEmit
```

## License

MIT
