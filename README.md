# Talon

A minimal Telegram bot powered by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Claude handles tools, sessions, compaction, and context. Talon wires it to Telegram.

## Features

**Input**
- Text messages (DM and group)
- Photos with captions (saved to workspace, analyzed by Claude)
- Documents/files (saved to workspace, readable by Claude)
- Voice messages (saved as OGG)
- Forwarded messages (origin context preserved)
- Reply context (quoted message included)

**Output**
- Streaming responses (message edits in real-time)
- Markdown → Telegram HTML formatting (bold, italic, code blocks, links)
- File attachments (workspace files created by Claude sent back)
- Smart message splitting for long responses

**Sessions**
- Persistent conversations via Claude SDK session management
- Sessions survive bot restarts (disk-backed session map)
- Automatic context compaction at 1M tokens
- Stale session recovery (auto-reset on expired sessions)

**Groups**
- Mention (`@bot`) or reply to activate
- Ignores unrelated messages
- Sender names included in prompts

## Setup

```bash
git clone https://github.com/dylanneve1/talon.git
cd talon
npm install

cp .env.example .env
# Add your Telegram bot token from @BotFather

npm start
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to be installed and authenticated.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TALON_BOT_TOKEN` | — | Telegram bot token (required) |
| `TALON_MODEL` | `claude-sonnet-4-6` | Claude model ID |
| `TALON_SYSTEM_PROMPT` | _(built-in)_ | Custom system prompt |
| `TALON_MAX_THINKING_TOKENS` | `10000` | Thinking budget per turn |
| `TALON_MAX_MESSAGE_LENGTH` | `4000` | Max chars before splitting |
| `TALON_VERBOSE` | `false` | Detailed logging |

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Introduction |
| `/reset` | Clear session |
| `/status` | Model, session, uptime |

## Architecture

```
Telegram ←→ grammY ←→ Talon ←→ Claude Agent SDK ←→ Claude API
                        ↕
                    workspace/
                    ├── sessions.json    (chat → session ID map)
                    ├── uploads/         (photos, documents, voice)
                    └── ...              (files created by Claude)
```

Talon is intentionally thin. The Claude Agent SDK manages:
- Conversation history (JSONL persistence)
- Automatic context compaction
- Tool execution (file I/O, shell, web search)
- Session resume across restarts
- Prompt caching

Talon manages:
- Telegram protocol (polling, message routing, formatting)
- Group mention/reply filtering
- Chat → SDK session mapping
- Media download/upload
- Streaming response display

## License

MIT
