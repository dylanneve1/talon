# Talon

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude](https://img.shields.io/badge/Claude_Agent_SDK-Anthropic-D97706)](https://github.com/anthropics/claude-agent-sdk-typescript)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A Telegram bot powered by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Claude handles tools, sessions, compaction, and context. Talon wires it to Telegram.

## Quick Start

```bash
git clone https://github.com/dylanneve1/talon.git
cd talon
npm install

cp .env.example .env
# Add your Telegram bot token from @BotFather

npm start
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) to be installed and authenticated.

## Features

**Input**
- Text messages (DM and group)
- Photos with captions (saved to workspace, analyzed by Claude with vision)
- Documents/files (saved to workspace, readable by Claude)
- Voice messages (saved as OGG)
- Videos (saved to workspace)
- GIFs/animations (saved to workspace)
- Stickers (file_id captured for reuse)
- Forwarded messages (origin context preserved)
- Reply context (quoted message included)
- Edited messages (re-processed with edit context)
- Inline keyboard callback data (button presses forwarded to Claude)

**Output & Tools (19 MCP tools + Claude built-in tools)**
- Streaming responses with thinking indicator and text cursor
- Markdown to Telegram HTML formatting (bold, italic, code blocks, links, strikethrough)
- Automatic typing indicator during processing
- Smart message splitting for long responses
- Message debouncing (rapid messages batched into single queries)

| Tool | Description |
|------|-------------|
| `send` | Unified send tool -- text, photos, videos, files, voice, stickers, polls, locations, contacts, dice, GIFs. Supports replies, buttons, and scheduling. |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent message |
| `delete_message` | Delete a message |
| `forward_message` | Forward a message within the chat |
| `pin_message` / `unpin_message` | Pin or unpin a message |
| `read_chat_history` | Read recent messages with metadata |
| `search_chat_history` | Search messages by keyword |
| `get_user_messages` | Get messages from a specific user |
| `get_message_by_id` | Retrieve a specific message by its ID |
| `list_chat_members` | List known users in the chat |
| `get_member_info` | Get detailed info about a user by ID |
| `get_chat_info` | Get chat title, type, member count |
| `get_chat_admins` | Get list of chat administrators |
| `get_chat_member_count` | Get total member count |
| `set_chat_title` / `set_chat_description` | Change chat title or description (admin) |
| `cancel_scheduled` | Cancel a scheduled message |

**Personality & Memory**
- Configurable personality via `prompts/soul.md`
- Persistent memory system (`workspace/memory/memory.md`) -- Claude updates it naturally during conversations
- Daily interaction logs (`workspace/logs/YYYY-MM-DD.md`) for continuity across sessions
- Session continuity: recent messages prepended on restart so Claude doesn't lose context

**Proactive Mode**
- Periodically checks registered chats for new messages
- Decides whether to respond, react, or stay silent
- Toggle per-chat with `/proactive on|off`
- Configurable interval via `TALON_PROACTIVE_INTERVAL_MS` env var (default: 1 hour)

**Sessions**
- Persistent conversations via Claude SDK session management
- Sessions survive bot restarts (disk-backed session map)
- Automatic context compaction at 1M tokens
- Stale session recovery (auto-reset on expired sessions)
- Session continuity: last 3 messages prepended on resume

**Groups**
- Mention (`@bot`) or reply to activate
- Ignores unrelated messages
- Sender names included in prompts
- Conversation threading: sender's recent messages included for context

**Monitoring**
- Consistent structured logging: `[HH:MM:SS] [component] message`
- Watchdog: warns if no messages processed for 10 minutes
- Error tracking: last 20 errors stored for admin review
- Health check: uptime, message count, error count
- GramJS connection monitor with automatic reconnection

## Commands

| Command | Description |
|---------|-------------|
| `/start` | Introduction |
| `/settings` | View and change all chat settings (model, effort, proactive) |
| `/status` | Session info, usage, context window, workspace size, and stats |
| `/ping` | Health check with latency, component status, and uptime |
| `/model` | Show or change model (sonnet, opus, haiku) |
| `/effort` | Set thinking effort level (off, low, medium, high, max, adaptive) |
| `/proactive` | Toggle proactive check-ins (on/off) |
| `/reset` | Clear session and start fresh |
| `/help` | All commands and features |

## Admin Commands

Admin commands are restricted to the bot owner.

| Command | Description |
|---------|-------------|
| `/admin stats` | Uptime, total messages, cost across all sessions, memory usage |
| `/admin errors` | Last 5 errors with timestamps |
| `/admin chats` | List all active chat sessions with usage |
| `/admin broadcast <text>` | Send a message to all active chats |
| `/admin kill <chatId>` | Force-reset a specific chat session |
| `/admin logs` | Last 20 lines of `/tmp/talon.log` |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `TALON_BOT_TOKEN` | -- | Telegram bot token (required) |
| `TALON_MODEL` | `claude-sonnet-4-6` | Claude model ID |
| `TALON_SYSTEM_PROMPT` | _(built-in)_ | Custom system prompt override |
| `TALON_WORKSPACE` | `./workspace` | Workspace directory for files and sessions |
| `TALON_MAX_MESSAGE_LENGTH` | `4000` | Max chars before splitting |
| `TALON_VERBOSE` | `false` | Detailed logging |
| `TALON_PROACTIVE` | `1` | Enable proactive check-ins (set to `0` to disable) |
| `TALON_PROACTIVE_INTERVAL_MS` | `3600000` | Proactive check interval (ms) |
| `TALON_API_ID` | -- | Telegram API ID for full history access (optional) |
| `TALON_API_HASH` | -- | Telegram API hash for full history access (optional) |

## Architecture

```
Telegram <-> grammy <-> Talon <-> Claude Agent SDK <-> Claude API
                        |   |
                   MCP bridge     watchdog
                  (localhost:19876)
                        |
                    workspace/
                    +-- sessions/
                    |   +-- sessions.json
                    |   +-- chat-settings.json
                    +-- memory/memory.md
                    +-- logs/YYYY-MM-DD.md
                    +-- uploads/
                    +-- files/
                    +-- scripts/
                    +-- data/
                    +-- .user-session
```

**Talon is intentionally thin.** The Claude Agent SDK manages:
- Conversation history (JSONL persistence)
- Automatic context compaction
- Tool execution (file I/O, shell, web search)
- Session resume across restarts
- Prompt caching

**Talon manages:**
- Telegram protocol (polling, message routing, formatting)
- Group mention/reply filtering with conversation threading
- Chat to SDK session mapping with continuity
- Media download/upload (photos, videos, GIFs, voice, documents, stickers)
- Streaming response display with thinking indicators
- Typing indicator auto-management
- Inline keyboard button handling
- Message debouncing and scheduling
- MCP tool bridge for 19 Telegram action tools
- Per-chat settings (model, effort, proactive mode)
- Persistent memory and daily logs
- Health monitoring, structured logging, and error tracking

## License

MIT
