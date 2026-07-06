# Talon Companion

A beautiful, cross-platform client for [Talon](../../README.md) — one Flutter
codebase for **Windows, macOS, Linux, and Android** (iOS/web build too).

It speaks the **Talon Client Bridge Protocol** (HTTP + Server-Sent Events) to a
Talon daemon running the `native` frontend:

- **Desktop** — zero-config local mode: start Talon on the same machine and
  the app finds its bridge automatically.
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
- Remote bridge profiles for phones or other machines
- Modern dark, glassy theme

## Running it

Requires the [Flutter SDK](https://docs.flutter.dev/get-started/install)
(3.27+). `macos/` and `android/` are committed real source (with the
required entitlement/manifest patches already applied — see below), so
there's no scaffold step for those. `windows/`, `linux/`, `ios/`, and
`web/` are still generated on demand:

```bash
cd apps/companion
flutter create --platforms=windows,linux .   # one-time scaffold for the rest
flutter pub get
flutter run -d macos       # or android / windows / linux
flutter run -d <android-device>
```

**Why `macos/`/`android/` are committed instead of scaffolded:** Flutter's
default macOS template enables App Sandbox but omits the outbound-network
entitlement (`com.apple.security.network.client`), and Android blocks plain
HTTP by default since API 28 — and this bridge is HTTP-only, no TLS. Both
silently break remote-bridge connections (`SocketException ... Operation
not permitted, errno = 1` on macOS; a cleartext-blocked error on Android)
even with a correct host/port/token, and a fresh `flutter create` would
re-drop the fix every time. So instead of a script someone has to remember
to re-run, those two platforms are tracked as normal source, just like any
other Flutter app ships. If you ever need to re-scaffold either from
scratch, use `scripts/fix-macos-entitlements.sh` /
`scripts/fix-android-cleartext.sh` (idempotent) or dispatch
`.github/workflows/companion-scaffold.yml`.

On first launch, pick **This computer** (desktop) or **Remote bridge** (enter a
host/IP + token).

In **This computer** mode, Talon must already be running with the `native`
frontend. When the native bridge starts, Talon writes
`~/.talon/native-bridge.json` with the loopback host, actual bound port,
optional token, scheme, process id, protocol version, and timestamps. The file
is mode `0600` because it can contain the bridge token. The companion reads
that file and connects to `127.0.0.1` automatically, including when Talon had to
fall back to the next free port.

For remote access, run the daemon with a reachable bridge:

```jsonc
// ~/.talon/config.json
{
  "frontend": "native",
  "native": { "host": "0.0.0.0", "port": 19880, "token": "your-secret" }
}
```

## Protocol

The wire contract lives on the daemon side in
[`src/frontend/native/protocol.ts`](../../src/frontend/native/protocol.ts)
and is mirrored in Dart under [`lib/src/models/`](lib/src/models). Endpoints:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/health` | Identity + status (unauthenticated) |
| GET  | `/events` | SSE stream of all events |
| GET/POST | `/chats` `/chats/rename` `/chats/delete` `/chats/reset` `/chats/pulse` | Chat management |
| POST | `/queue` | Set/replace/clear a chat's queued follow-up |
| GET  | `/history?chatId=` | Recent messages |
| POST | `/send` | Send a user message |
| GET/POST | `/models` `/model` `/effort` | Model + effort |
| GET/POST | `/config` | Read / change daemon settings |
| POST | `/control` | Daemon-level actions (`restart`, `dream`) |

All non-`/health` routes accept a bearer token (`Authorization: Bearer …`, or
`?token=` for the SSE stream) when the daemon is configured with one.
