# Kilo backend Docker harness

Containerised Talon instance configured for the Kilo backend, running
against a dedicated test bot. Designed to coexist with a production
Talon process on the same host without state, port, or Telegram
collisions.

## Usage

```bash
# 1. Provide the test bot token (kept outside the repo)
set -a && source ~/.config/talon-tests/secrets.env && set +a

# 2. Prepare a workspace and config on the host
mkdir -p ~/.talon-kilo-test
cat > ~/.talon-kilo-test/talon.json <<'JSON'
{
  "frontend": "telegram",
  "backend": "kilo",
  "model": "claude-sonnet-4-6",
  "workspace": "/home/node/.talon/workspace"
}
JSON

# 3. Inject the token (keep it out of the tracked file)
sed -i "s|\"backend\":|\"botToken\": \"$TALON_TEST_BOT_TOKEN\", \"backend\":|" \
  ~/.talon-kilo-test/talon.json

# 4. Build and run
cd docker/kilo-test
docker compose up --build -d
docker compose logs -f talon-kilo-test
```

After step 4, DM the test bot from any Telegram account. The container
will respond through the Kilo backend.

To tear down:

```bash
cd docker/kilo-test
docker compose down
```

The host workspace at `~/.talon-kilo-test/` survives `down`/`up`. Wipe
it manually for a clean-room run.

## Coexistence with production

The harness is wired to never collide with a production Talon process:

| Resource         | Production            | Kilo Docker harness         |
| ---------------- | --------------------- | --------------------------- |
| Workspace        | `~/.talon/`           | `~/.talon-kilo-test/`       |
| Telegram bot     | Production bot token  | Test bot token              |
| Gateway port     | 19876                 | 19878 (container-internal)  |
| Kilo HTTP port   | n/a                   | 4097 (container-internal)   |
| Container name   | n/a (systemd service) | `talon-kilo-test`           |

Both can run simultaneously on the same host.

## Requirements

- Docker Engine with the `docker compose` plugin.
- Test bot token at `~/.config/talon-tests/secrets.env` (mode `0600`).
  The file is gitignored and lives outside the repository.

## Notes

- The harness runs from TypeScript sources via `node --import tsx`, so
  the image carries `devDependencies`. It is not optimised for a
  minimal production image — that is the root `Dockerfile`'s job.
- Neither port `19878` (Talon gateway) nor `4097` (Kilo HTTP server)
  is published outside the container. The bot reaches Telegram via
  outbound HTTPS only.
