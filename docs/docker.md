# Running Talon in Docker

**On TrueNAS SCALE?** Follow [truenas.md](truenas.md). It's a ten-minute
install from the published image.

## Quick install (any Docker host)

```bash
mkdir -p ~/.talon ~/.claude
docker run -d --name talon --restart unless-stopped \
  --user "$(id -u):$(id -g)" \
  -e TALON_BOT_TOKEN=123456:ABC... \
  -e TALON_ADMIN_USER_ID=123456789 \
  -v ~/.talon:/home/bun/.talon -v ~/.claude:/home/bun/.claude \
  ghcr.io/dylanneve1/talon:latest
docker exec -it talon claude auth login    # once, for the Claude backend
docker restart talon
```

Then DM your bot. To use the companion app instead of (or as well as)
Telegram, add `-p 19880:19880 -e TALON_BRIDGE_URL=https://<this-host>:19880`,
and see [First boot](#first-boot-configuration) for the rest.

Images are published on every release as `latest` and `X.Y.Z`. For access
from outside your network, put a reverse proxy with client certificates in
front ([mtls.md](mtls.md)).

## Building it yourself

The root `Dockerfile` builds the production image and `docker-compose.yml`
runs it. The image runs as UID 1000 with `HOME=/home/bun`, and all persistent
state lives in bind mounts:

| Container path        | What it holds                                                     |
| --------------------- | ----------------------------------------------------------------- |
| `/home/bun/.talon`    | Config, sessions, workspace, memory, bridge keys                  |
| `/home/bun/.claude`   | Claude Code credentials (Claude backend)                          |
| `/home/bun/.gemini`   | Antigravity OAuth cache + shared MCP config (agy backend)         |

```bash
docker compose up -d --build
docker compose logs -f talon
```

See [`packaging/README.md`](../packaging/README.md#docker-image) for how the
image itself is built.

## First-boot configuration

If `~/.talon/config.json` doesn't exist when the container starts, the
entrypoint writes one from these variables. It never overwrites an existing
file: after the first boot, edit the config (or use `/settings` or the
companion app).

| Variable              | Becomes                                   | Notes                                                                        |
| --------------------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| `TALON_FRONTEND`      | `frontend`                                | Comma list allowed. Default: `telegram` with a bot token, else `native`.     |
| `TALON_BOT_TOKEN`     | `botToken`                                | Telegram.                                                                    |
| `TALON_ADMIN_USER_ID` | `adminUserId`, `allowedUsers: [id]`       | Required with Telegram. A fresh bot answers only its admin.                  |
| `TALON_BACKEND`       | `backend`                                 | `claude`, `agy`, `codex`, `kilo`, `opencode`, `openai-agents`.               |
| `TALON_MODEL`         | `model`                                   |                                                                              |
| `TALON_BRIDGE_PORT`   | `native.port`                             | Default `19880`.                                                             |
| `TALON_BRIDGE_URL`    | `native.publicUrl`                        | What devices dial. Pairing links need it inside a container.                 |
| `TALON_BRIDGE_TOKEN`  | `native.token`                            | Default: auto-minted into `~/.talon/keys/bridge-token`.                      |

When `native` is among the frontends, the bridge binds `0.0.0.0` (loopback
is unreachable from outside a container). That turns on TLS and a bearer
token automatically.

## Running as another user

The image runs as UID 1000 by default but works under any UID, e.g.
`--user 568:568` on TrueNAS. `HOME` and the mount points inside it are
world-writable, and state goes into your mounts. The entrypoint warns if a
mount isn't writable by the container's user, which is the usual cause of
permission errors. You can also point `HOME` at a single mount
(`-e HOME=/data -v /path:/data`) to keep `.talon`, `.claude`, `.gemini` and
`~/.claude.json` in one place, which is what the TrueNAS setup does.

## Antigravity (`agy`) backend

The image ships the tools agy shells out to (`git`, `ripgrep`). Two things
have to come from you: the `agy` binary (there is no npm package to install
it from) and a one-time Google sign-in (there is no API key).

### 1. Provide the binary

Pick one:

- **Bind-mount the host's binary** (the default in `docker-compose.agy.yml`).
  If `agy` isn't at `/usr/local/bin/agy` on the host, point at it:

  ```bash
  export AGY_BINARY_HOST="$(command -v agy)"
  ```

- **Bake it into the image.** Pass the URL of the Linux binary for your
  architecture and its SHA-256. The build verifies the digest and fails on a
  mismatch:

  ```bash
  AGY_DOWNLOAD_URL=https://…/agy-linux-amd64 \
  AGY_SHA256=<sha256> \
  docker compose -f docker-compose.yml -f docker-compose.agy.yml build
  ```

  Then delete the `/usr/local/bin/agy` mount line from
  `docker-compose.agy.yml`, because a mount there would hide the baked copy.

Either way the binary ends up at `/usr/local/bin/agy`, which is on `PATH`,
so no `agyBinary` / `AGY_BINARY` setting is needed.

### 2. Sign in once

agy caches its OAuth token at
`~/.gemini/antigravity-cli/antigravity-oauth-token`, and headless runs reuse
it. The compose override mounts the host's `~/.gemini`, so:

- **Signed in on the host already?** Nothing to do. The container reuses the
  cache.
- **No browser on the host?** Sign in with `agy` on any desktop, then copy
  `~/.gemini/antigravity-cli/antigravity-oauth-token` into the mounted
  `~/.gemini/antigravity-cli/` on the Docker host (owner UID 1000, mode
  `0600`).
- **Or try it in the container:** `docker compose exec -it talon agy`. If the
  CLI prints a sign-in URL you can open elsewhere, finish there. If it can
  only open a local browser, use the copy route above.

### 3. Run it

```bash
docker compose -f docker-compose.yml -f docker-compose.agy.yml up -d --build
```

and set `"backend": "agy"` in `~/.talon/config.json`, or switch per chat with
`/model`. `docker compose exec talon bun src/cli.ts doctor` (or
`node --import tsx src/cli.ts doctor` on the Node image) checks the binary,
its version, the cached sign-in and the model list.

`~/.gemini/config/mcp_config.json` is **shared** with any agy you run on the
host. Talon only writes keys under its own `__talon__` prefix and preserves
everything else. But a Talon on the host and one in the container, both on
agy, prune each other's entries at startup. See
[`docker/agy-test/README.md`](../docker/agy-test/README.md#coexistence-with-production).
