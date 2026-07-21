# talon-node — headless Talon mesh device

A single static binary that attaches any server, VM, or headless box to a
Talon daemon's device mesh **without the full companion app**. It speaks the
same client bridge protocol the Flutter companion does, so the daemon — and
every companion app — sees it as just another mesh device, and `teleport`
works out of the box.

- **Zero dependencies** on the host: one static Go binary (`CGO_ENABLED=0`,
  stdlib only), ~6 MB. Linux (amd64/arm64/arm), macOS, and Windows.
- **Outbound-only**: the node dials the bridge; nothing listens on the host.
- **Pinned TLS**: the bridge's self-signed certificate is pinned by SHA-256
  fingerprint (trust-on-first-use, then enforced) — same model as the app.
- **Full mesh surface**: `exec`, `read_file`, `write_file`, `list_dir`,
  `stat`, `delete`, `mkdir`, `move`, streamed `upload_file`/`download_file`,
  `status`, `ring`. That is the entire teleport substrate, so
  `teleport(device)` gives the model a real shell + file tools on the node.

## Quick start

```sh
# Build (or grab a release binary):
cd apps/node && go build -o talon-node .

# First run — mints a device id, pins the bridge cert on first connect:
./talon-node run --bridge https://<daemon-host>:19880 --token <bridge-token> --name my-server

# Install as a boot service (systemd / launchd / Windows scheduled task):
./talon-node install --bridge https://<daemon-host>:19880 --token <bridge-token>

# Sanity check:
./talon-node status
```

Config lives at `~/.talon-node/config.json` (0600 — it holds the bearer
token). Flags and env vars (`TALON_BRIDGE`, `TALON_TOKEN`,
`TALON_NODE_NAME`) override the file.

```json
{
  "bridge": "https://100.64.0.7:19880",
  "token": "…",
  "name": "my-server",
  "deviceId": "node-…",
  "fingerprint": "a1eeb640…"
}
```

`deviceId` is minted once and persisted so redeploys/restarts never create
duplicate registry entries. `fingerprint` is captured on the first
successful authenticated connect (TOFU) and enforced afterwards; pre-seed it
via `--fingerprint` for a fully pinned first contact (`/health` on the
bridge reports it).

## How it plugs in

```
talon-node                        Talon daemon (native frontend)
──────────                        ──────────────────────────────
POST /devices/register  ── 60s ─▶ mesh registry (presence, capabilities)
GET  /events (SSE)      ◀────────  device_command events (exec, fs, …)
POST /devices/command-result ───▶ resolves the pending mesh tool call
POST/GET /devices/file  ◀───────▶ streamed transfers (one-time tokens)
```

The daemon needs the `native` frontend enabled (the same bridge companion
apps pair with). No daemon-side changes are required for headless nodes.

## Service management

| OS      | Mechanism                                    | Notes                                              |
| ------- | -------------------------------------------- | -------------------------------------------------- |
| Linux   | systemd unit (system as root, else user)     | user units need `loginctl enable-linger` for boot  |
| macOS   | LaunchAgent (`com.talon.node`)               | per-user, `KeepAlive` restarts on crash            |
| Windows | Scheduled task (`TalonNode`, ONSTART/SYSTEM) | plain console binary — no SCM plumbing needed      |

## Building all targets

```sh
./scripts/build-all.sh          # → build/talon-node-<os>-<arch>[.exe]
```

The `Headless Node` workflow builds the same matrix in CI and attaches the
binaries to published releases.

## Capabilities vs. the companion app

Headless nodes do not advertise `locate` (no GPS) or `install_apk`
(Android-only self-update). Everything else matches the app's device-control
surface, including the capped exec output contract (192 KB head + rolling
64 KB tail) that teleport's cwd tracking depends on.
