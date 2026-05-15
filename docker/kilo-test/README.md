# Kilo backend live-test harness

Spins a containerised Talon configured for the Kilo backend, against the
dedicated `@talondebugbot` Telegram bot. Runs alongside production Talon
on the same VPS — separate workspace, separate port, separate container
name.

## Why this exists

The Kilo backend now supports streaming, end_turn detection,
flow-violation retry, model fallback, plugin prompts, and time tags — all
behaviours that can only be verified against a real Kilo HTTP server +
real Telegram round-trip. Unit tests (the SDK-stub tier in
`src/__tests__/sdk-stub.test.ts`) cover individual primitives, but the
sync `session.prompt` + SSE event loop interaction is hard to mock
faithfully.

This harness solves that: build the image once, send messages to the
test bot, watch the logs.

## Pre-requisites

- Docker Engine + `docker compose` plugin on the VPS.
- Test bot token saved at `~/.config/talon-tests/secrets.env` with
  `0600` perms. Provided by Dylan, never committed.

## First-time setup

```bash
# 1. Source the test bot token
set -a && source ~/.config/talon-tests/secrets.env && set +a

# 2. Create the test workspace
mkdir -p ~/.talon-kilo-test

# 3. Drop in a minimal talon.json. Pick ONE of:

# Option A: env-driven (recommended)
cat > ~/.talon-kilo-test/talon.json <<'JSON'
{
  "frontend": "telegram",
  "backend": "kilo",
  "botToken": "REPLACE_WITH_TALON_TEST_BOT_TOKEN_VALUE",
  "model": "claude-sonnet-4-6",
  "workspace": "/home/node/.talon/workspace"
}
JSON

# Then `sed -i "s/REPLACE_WITH_TALON_TEST_BOT_TOKEN_VALUE/$TALON_TEST_BOT_TOKEN/" \
#   ~/.talon-kilo-test/talon.json`
# (the file should NEVER contain the literal token on a tracked path —
# keep it inside the gitignored ~/.talon-kilo-test dir only)
```

The first run will create empty `sessions/`, `workspace/`, and other
dirs under `~/.talon-kilo-test/`.

## Run

```bash
cd /path/to/talon/docker/kilo-test
docker compose up --build -d
docker compose logs -f talon-kilo-test
```

Then DM `@talondebugbot` from any Telegram account. The bot will respond
through the Kilo backend.

### Verifying new features

The PR adds 1:1 parity with the Claude SDK backend. Quick smoke checks:

1. **Streaming** — Send a message that needs a long reply
   ("write a 200-word poem about Talon"). You should see typing-indicator
   updates rather than a single dump at the end. (Telegram drafts UX
   depends on the frontend wiring — verify the `[stream]` log lines fire
   in `docker compose logs`.)
2. **End_turn** — Send a normal message. The model should call
   `end_turn(text=...)` rather than relying on plain text fallback. Check
   logs for `tool_calls.end_turn` counter increments.
3. **Flow violation retry** — Use a model that you know forgets to call
   end_turn (some open-source models do). Should see
   `scratchpad.flow_violation_retried` log line.
4. **Time tag** — `docker compose logs` should show prompts starting
   with `[2026-MM-DD HH:MM weekday (TZ)]` instead of raw text.
5. **Plugin prompt additions** — If mempalace is enabled, the system
   prompt should include the palace-recall instructions on first-turn
   sessions.

## Teardown

```bash
cd /path/to/talon/docker/kilo-test
docker compose down
```

The host workspace at `~/.talon-kilo-test/` persists across `down/up`.
Wipe it manually if you want a fresh state.

## Coexistence with prod

The harness is designed to never collide with the running prod Talon:

| Resource | Prod | Kilo test |
|---|---|---|
| Workspace | `~/.talon/` | `~/.talon-kilo-test/` |
| Bot | Real production bot | `@talondebugbot` |
| Bridge port | 19876 | 19878 (internal-only) |
| Kilo HTTP port | n/a (uses Claude SDK) | 4097 (internal-only) |
| Container name | n/a (systemd service) | `talon-kilo-test` |

Both can run simultaneously. Different bots, different chats, different
state.
