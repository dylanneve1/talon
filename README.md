# Talon

A minimal Telegram bot powered by the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Claude handles tools, sessions, compaction, and context. Talon wires it to Telegram.

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
- Photos with captions (saved to workspace, analyzed by Claude)
- Documents/files (saved to workspace, readable by Claude)
- Voice messages (saved as OGG)
- Videos (saved to workspace)
- GIFs/animations (saved to workspace)
- Stickers (file_id captured for reuse)
- Forwarded messages (origin context preserved)
- Reply context (quoted message included)
- Inline keyboard callback data (button presses forwarded to Claude)

**Output & Tools (33+ MCP tools)**
- Streaming responses (message edits in real-time)
- Markdown to Telegram HTML formatting (bold, italic, code blocks, links, strikethrough)
- Automatic typing indicator during processing
- Smart message splitting for long responses

| Tool | Description |
|------|-------------|
| `send_message` | Send a text message with optional reply-to |
| `send_message_with_buttons` | Send a message with inline keyboard (URL or callback buttons) |
| `reply_to` | Reply to a specific message by ID |
| `react` | Add emoji reaction to a message |
| `edit_message` | Edit a previously sent message |
| `delete_message` | Delete a message |
| `pin_message` | Pin a message |
| `unpin_message` | Unpin a message |
| `forward_message` | Forward a message to another chat |
| `copy_message` | Copy a message (like forward, without "Forwarded from" header) |
| `send_file` | Send a workspace file as a document |
| `send_photo` | Send an image inline |
| `send_video` | Send a video from workspace |
| `send_animation` | Send a GIF/animation from workspace |
| `send_voice` | Send an OGG file as a voice message |
| `send_sticker` | Send a sticker by file_id |
| `send_poll` | Create a poll or quiz |
| `send_location` | Send a location pin |
| `send_contact` | Share a contact card |
| `send_dice` | Send an animated dice/emoji |
| `send_chat_action` | Show typing/uploading/recording indicator |
| `schedule_message` | Send a message after a delay |
| `cancel_scheduled` | Cancel a scheduled message |
| `read_chat_history` | Read recent messages with metadata |
| `search_chat_history` | Search messages by keyword |
| `get_user_messages` | Get messages from a specific user |
| `get_message_by_id` | Retrieve a specific message by its ID |
| `list_chat_members` | List known users in the chat |
| `get_member_info` | Get detailed info about a user by ID |
| `get_chat_info` | Get chat title, type, member count |
| `get_chat_member` | Get info about a specific user |
| `get_chat_admins` | Get list of chat administrators |
| `get_chat_member_count` | Get total member count |
| `set_chat_title` | Change the chat title (admin) |
| `set_chat_description` | Change the chat description (admin) |

**Sessions**
- Persistent conversations via Claude SDK session management
- Sessions survive bot restarts (disk-backed session map)
- Automatic context compaction at 1M tokens
- Stale session recovery (auto-reset on expired sessions)

**Groups**
- Mention (`@bot`) or reply to activate
- Ignores unrelated messages
- Sender names included in prompts

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
| `/status` | Session info, usage, and stats |
| `/reset` | Clear session and start fresh |
| `/help` | All commands and features |

## Architecture

```
Telegram <-> grammY <-> Talon <-> Claude Agent SDK <-> Claude API
                        |
                   MCP bridge (localhost:19876)
                        |
                    workspace/
                    ├── sessions.json    (chat -> session ID map)
                    ├── uploads/         (photos, documents, voice, video, GIFs)
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
- Chat to SDK session mapping
- Media download/upload (photos, videos, GIFs, voice, documents, stickers)
- Streaming response display
- Typing indicator auto-management
- Inline keyboard button handling
- Message scheduling
- MCP tool bridge for 33+ Telegram actions

## License

MIT
