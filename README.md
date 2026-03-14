# Talon

A minimal Telegram bot powered by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Claude handles everything — tools, session management, compaction, context — Talon just wires it to Telegram.

## What it does

- **DMs**: Responds to all direct messages
- **Groups**: Responds when mentioned (`@bot`) or replied to
- **Sessions**: Conversations persist across messages via the SDK's built-in session management
- **Tools**: The SDK's full tool suite (file read/write, exec, web search) is available
- **Context**: 1M token context window with automatic compaction

## Setup

```bash
# Clone
git clone https://github.com/dylanneve1/talon.git
cd talon

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your Telegram bot token from @BotFather

# Run
npm start
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to be installed and authenticated (`claude` CLI must be available in PATH).

## Configuration

All config via environment variables or `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TALON_BOT_TOKEN` | — | Telegram bot token (required) |
| `TALON_MODEL` | `claude-sonnet-4-6` | Claude model ID |
| `TALON_SYSTEM_PROMPT` | _(built-in)_ | Custom system prompt |
| `TALON_MAX_THINKING_TOKENS` | `10000` | Thinking budget per turn |
| `TALON_VERBOSE` | `false` | Detailed logging |

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Introduction |
| `/reset` | Clear session, start fresh |
| `/status` | Show model, session, uptime |

## Architecture

```
Telegram ← grammy → Talon → Claude Agent SDK → Claude API
                       ↕
                   sessions.json (chat→session mapping)
                   workspace/ (SDK session files)
```

Talon is intentionally thin. The Claude Agent SDK handles:
- Conversation history and JSONL persistence
- Automatic context compaction when approaching limits
- Tool execution (file I/O, shell commands, web search)
- Session resume across restarts
- Prompt caching for fast responses

Talon handles:
- Telegram bot protocol (polling, message routing)
- Group mention/reply filtering
- Chat → SDK session ID mapping
- Message splitting for Telegram's 4096 char limit

## License

MIT
