# Headless mesh nodes (talon-node)

Servers and VMs can join the device mesh without the Flutter companion app:
`apps/node` builds **talon-node**, a single static Go binary that speaks the
client bridge protocol directly. The daemon and every companion app see it
as a normal mesh device; `teleport`, `device_exec`, and the streamed file
transfer tools work unchanged.

## Why a separate binary

The companion app is the right client for phones and laptops — GUI, GPS,
battery telemetry, notifications. For a rack server none of that applies,
and shipping Flutter to a headless box is heavy. The bridge protocol is
deliberately client-agnostic (`src/frontend/native/protocol.ts`), so a mesh
device only needs four HTTP touchpoints:

| Touchpoint                     | Purpose                                    |
| ------------------------------ | ------------------------------------------ |
| `POST /devices/register`       | registration + 60s heartbeat (presence)    |
| `GET /events` (SSE)            | receive `device_command` events            |
| `POST /devices/command-result` | answer commands by correlation id          |
| `GET/POST /devices/file`       | streamed transfers via one-time tokens     |

talon-node implements exactly that in ~stdlib Go: static binary, no runtime
dependencies, outbound-only networking, TLS pinned to the bridge cert's
SHA-256 fingerprint (trust-on-first-use, then enforced).

## Capability surface

Advertised at registration — the daemon gates commands on this list:

```
ring, status, exec, read_file, write_file, list_dir, stat, delete,
mkdir, move, upload_file, download_file, update_node
```

That is the app's full device-control surface minus `locate` (no GPS) and
`install_apk` (Android self-update), plus `update_node` — the headless
equivalent of remote self-update (`update_device` for the companion). Because
teleport is built entirely on `exec` + the fs commands, a headless node is a
first-class teleport target, including the capped exec output contract
(192 KB head + rolling 64 KB tail) the teleport cwd marker rides on.

The node's `appVersion` tracks the Talon release it was built against
(`<talon-version>+<sha>`), so the mesh shows exactly which Talon each node
matches, and `update_node` streams a new binary + verifies + swaps + restarts
in place — see `apps/node/README.md`.

No daemon-side changes were needed — headless nodes registered against an
unmodified bridge.

## Deploying a node

See `apps/node/README.md` for flags, config, and service install
(systemd/launchd/scheduled task). The short version:

```sh
talon-node install --bridge https://<daemon>:19880 --token <bridge-token> --name my-server
```

Remote nodes are best pointed at the daemon over a tailnet/VPN address —
the bridge token grants the full bridge API, so avoid exposing the port
publicly. Scoping per-device tokens is a known follow-up.

## Release artifacts

`.github/workflows/node.yml` vets, tests, and cross-compiles
linux/amd64+arm64+arm, darwin/amd64+arm64, and windows/amd64 on every PR
touching `apps/node`, and attaches the binaries to published releases.
