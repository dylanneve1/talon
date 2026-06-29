# Talon Companion

A beautiful, cross-platform client for [Talon](../../README.md) — one Flutter
codebase for **Windows, macOS, Linux, and Android** (iOS/web build too).

It speaks the **Talon Client Bridge Protocol** (HTTP + Server-Sent Events) to a
Talon daemon running the `desktop` frontend:

- **Desktop** — connects to a Talon on the same machine and, if one isn't
  running, launches it for you (`TALON_FRONTEND_OVERRIDE=desktop`).
- **Mobile / remote** — connects to a Talon bridge over the network by host/IP
  + token, so your phone can drive a Talon running on your desktop or a server.

The bridge is client-agnostic: this app is the reference client, but anything
that speaks the protocol works.

## Features

- Multiple chats with a time-grouped, searchable history sidebar (ChatGPT-style)
- Live streaming replies, with the model's reasoning and tool calls shown inline
- Full Markdown rendering (code blocks, tables, lists, links)
- Per-chat **model** + **reasoning effort** + **pulse** + **session reset**
- **Settings sync** — read and change the daemon's own config (default model,
  display name, timezone, pulse/heartbeat/dream) and see live status
- Restart the local daemon from the app
- Modern dark, glassy theme

## Running it

Requires the [Flutter SDK](https://docs.flutter.dev/get-started/install)
(3.27+). The per-OS runner folders are generated, not committed:

```bash
cd apps/companion
flutter create --platforms=windows,macos,linux,android .   # one-time scaffold
flutter pub get
flutter run -d windows     # or macos / linux
flutter run -d <android-device>
```

On first launch, pick **This computer** (desktop) or **Remote bridge** (enter a
host/IP + token). For remote access, run the daemon with a reachable bridge:

```jsonc
// ~/.talon/config.json
{
  "frontend": "desktop",
  "desktop": { "host": "0.0.0.0", "port": 19880, "token": "your-secret" }
}
```

## Protocol

The wire contract lives on the daemon side in
[`src/frontend/desktop/protocol.ts`](../../src/frontend/desktop/protocol.ts)
and is mirrored in Dart under [`lib/src/models/`](lib/src/models). Endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/health` | Identity + status (unauthenticated) |
| GET  | `/events` | SSE stream of all events |
| GET/POST | `/chats` `/chats/rename` `/chats/delete` `/chats/reset` `/chats/pulse` | Chat management |
| GET  | `/history?chatId=` | Recent messages |
| POST | `/send` | Send a user message |
| GET/POST | `/models` `/model` `/effort` | Model + effort |
| GET/POST | `/config` | Read / change daemon settings |

All non-`/health` routes accept a bearer token (`Authorization: Bearer …`, or
`?token=` for the SSE stream) when the daemon is configured with one.
