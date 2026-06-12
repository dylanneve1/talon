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
