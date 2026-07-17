# Packaging

Distribution artefacts for installing Talon outside the development tree.

## Contents

| Path                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `systemd/talon.service`         | Linux systemd unit for a source-checkout daemon run.     |
| `systemd/talon-package.service` | Linux systemd unit for an npm install (`talon` on PATH). |

The Dockerfile / Docker Compose configuration lives at the repository
root for convention (`docker compose up -d` from the checkout). The
`docker/` directory holds auxiliary harnesses (e.g. `docker/kilo-test/`
for backend-specific test bots), not the primary production image.

## Native launcher (`talon-driver`)

The binary distribution channels — an apt `.deb`, a Homebrew bottle, a
source install — ship the compiled launcher
([`native/talon-driver`](../native/talon-driver/)) as the `talon` entry
point instead of the npm `bin/talon.js` shim. It is a small native
per-arch executable that locates a Node >= 24 and execs `bin/talon.js`,
so packages don't depend on a particular Node being first on `PATH`.

Build the per-arch artefacts for packaging:

```sh
npm run build:driver:all   # x86_64/aarch64 × linux-musl/macos → native/talon-driver/dist/
```

A `.deb` or bottle that vendors its own Node can drop it at
`<prefix>/vendor/node` next to the launcher and it is picked up before
any system Node (full resolution order is in the driver's README). The
npm package is unchanged — it keeps shipping the portable
`bin/talon.js`, which works on every platform including Windows.

## Supervision harness (`talon-warden`)

The same channels should ship the Rust trigger-supervision harness
([`native/talon-warden`](../native/talon-warden/)) as
`bin/talon-warden` beside `bin/talon.js` (or anywhere, with
`TALON_WARDEN=<path>` set in the service environment). It is optional:
without it the trigger supervisor uses its in-process TS path; with it
trigger children get own-process-group kills, out-of-process timeouts,
and orphan-free teardown. Build per arch on a matching-OS builder:

```sh
npm run build:warden                                       # host arch → bin/talon-warden
node native/talon-warden/build.mjs --target=<rust-triple>  # cross (Linux targets) → dist/
```

## Hashing addon (`talon-blake3.node`)

Optional like the warden: ship
([`native/blake3-napi`](../native/blake3-napi/)) as
`bin/talon-blake3.node` (override: `TALON_BLAKE3_NODE`) and media
hashing runs on native SIMD off the event loop; without it the embedded
wasm module does the hashing. Build per arch the same way:

```sh
npm run build:napi                                        # host arch → bin/talon-blake3.node
node native/blake3-napi/build.mjs --target=<rust-triple>  # cross (Linux targets) → dist/
```

## Namespace FUSE addon (`talon-fusefs.node`)

Optional and Linux-only: ship
([`native/talon-fusefs`](../native/talon-fusefs/)) as
`bin/talon-fusefs.node` (override: `TALON_FUSEFS_NODE`) and the daemon
mounts the talon:// namespace at `~/.talon/ns` with live `proc/` and
`plugins/` views; without it the namespace is the plain symlink farm.
Build per arch the same way:

```sh
npm run build:fusefs                                        # host arch → bin/talon-fusefs.node
node native/talon-fusefs/build.mjs --target=<rust-triple>   # cross (Linux targets) → dist/
```
