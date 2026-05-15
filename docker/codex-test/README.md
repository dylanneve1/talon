# Codex backend Docker harness

Containerised Talon instance configured for the Codex backend, running
against a dedicated test bot. Designed to coexist with a production
Talon process on the same host without state, port, or Telegram
collisions.

## Usage

```bash
# 1. Provide the test bot token (kept outside the repo)
set -a && source ~/.config/talon-tests/secrets.env && set +a

# 2. Provide an OpenAI API key (or pre-authenticate codex with ChatGPT auth)
export OPENAI_API_KEY=sk-...

# 3. Prepare a workspace and config on the host
mkdir -p ~/.talon-codex-test
cat > ~/.talon-codex-test/talon.json <<'JSON'
{
  "frontend": "telegram",
  "backend": "codex",
  "model": "gpt-5-codex",
  "workspace": "/home/node/.talon/workspace"
}
JSON

# 4. Inject the test bot token
sed -i "s|\"backend\":|\"botToken\": \"$TALON_TEST_BOT_TOKEN\", \"backend\":|" \
  ~/.talon-codex-test/talon.json

# 5. Build and run
cd docker/codex-test
docker compose up --build -d
docker compose logs -f talon-codex-test
```

After step 5, DM the test bot from any Telegram account. The container
responds through the Codex backend.

To tear down:

```bash
cd docker/codex-test
docker compose down
```

The host workspace at `~/.talon-codex-test/` survives `down`/`up`.
Wipe it manually for a clean-room run.

## Coexistence with production

The harness is wired to never collide with a production Talon process:

| Resource         | Production            | Codex Docker harness        |
| ---------------- | --------------------- | --------------------------- |
| Workspace        | `~/.talon/`           | `~/.talon-codex-test/`      |
| Telegram bot     | Production bot token  | Test bot token              |
| Gateway port     | 19876                 | 19879 (container-internal)  |
| Container name   | n/a (systemd service) | `talon-codex-test`          |

Both can run simultaneously on the same host.

## Requirements

- Docker Engine with the `docker compose` plugin.
- Test bot token at `~/.config/talon-tests/secrets.env` (mode `0600`).
- An OpenAI API key in `OPENAI_API_KEY`, OR a pre-existing
  `~/.codex/auth.json` produced by `codex login` on the host
  (bind-mounted into the container).

## Notes

- The image runs Talon from TypeScript sources via `node --import tsx`,
  so `devDependencies` are included. Not optimised for a minimal
  production image.
- The Codex CLI is included via the `@openai/codex` package, which is
  a transitive dependency of `@openai/codex-sdk`. The container will
  invoke `codex` from `node_modules/.bin/`.
- Neither the Talon gateway (port 19879) nor any internal Codex
  process is published outside the container. The bot reaches Telegram
  and OpenAI via outbound HTTPS only.
