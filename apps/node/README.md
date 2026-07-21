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
- **Remote self-update**: `update_node` — the daemon streams a new binary,
  the node verifies its hash, atomically swaps its own binary, and restarts
  into it (in-place `execve` on Linux/macOS, so the mesh reconnects in
  seconds). Version tracks the Talon release it was built against.

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

## Versioning

The reported version tracks the **Talon release the binary was compiled
against**, so a node's `appVersion` in the mesh tells you exactly which Talon
it matches:

- Release/CI and `scripts/build-all.sh` builds report `<talon-version>+<sha>`
  (e.g. `3.1.1+c8c7437c`), stamped via `-ldflags -X main.ldflagsVersion=…`.
- A bare `go build .` reports the embedded Talon version (`version.txt`,
  kept in sync with the root `package.json` — CI fails if it drifts).

## Remote self-update

`update_node` (daemon-side mesh tool) streams a freshly-built binary to the
node, which re-hashes it, atomically swaps its own binary, and restarts into
it — an in-place `execve` on Linux/macOS (same pid, no supervisor
crash-accounting), a rename-aside + relaunch on Windows. A truncated or
mismatched binary is refused before the swap, so the running node is never
left broken. Build the replacement for the node's OS/arch first
(`talon-node-<os>-<arch>`), then confirm with `get_device_status` once
`appVersion` changes.

On Unix, `SIGHUP` also reloads the node into whatever binary is on disk —
handy for `systemctl reload`-style restarts after an out-of-band swap.

## Capabilities vs. the companion app

Headless nodes do not advertise `locate` (no GPS) or `install_apk`
(Android-only self-update); instead they advertise `update_node` for the
equivalent self-update. Everything else matches the app's device-control
surface, including the capped exec output contract (192 KB head + rolling
64 KB tail) that teleport's cwd tracking depends on.
