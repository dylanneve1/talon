# talon-fusefs

The `talon://` namespace as a real FUSE filesystem — an in-process
napi-rs addon (`bin/talon-fusefs.node`) that mounts over `~/.talon/ns`
while the daemon runs, so live views (`proc/`, `plugins/`) are ordinary
files for every process on the host.

## Design

FUSE stays off the hot path:

- **File-backed mounts are symlinks.** `home/`, `skills/`, … are served
  as symlink nodes pointing at their disk roots. The kernel follows
  them; file I/O runs at native speed and never enters this filesystem.
- **Synthetic mounts bridge to JS.** Everything under `proc/` and
  `plugins/` is answered live from the daemon's `Vfs` over a
  threadsafe-function bridge: the FUSE thread posts `(id, op, path)`,
  JS answers `reply(id, json)`, a 5s timeout answers EIO instead of
  hanging a reader on a wedged daemon.
- **Read-only + direct I/O.** `MountOption::RO` has the kernel answer
  all mutation with EROFS; `FOPEN_DIRECT_IO` makes readers read to EOF
  instead of trusting a stat that can go stale between getattr and
  read of live content. No `AutoUnmount` — fuser implements it via
  `allow_other`, which fusermount refuses without a system-wide
  `/etc/fuse.conf` opt-in; a daemon that dies uncleanly leaves a stale
  mount that the TS lifecycle detects (ENOTCONN) and lazy-unmounts at
  the next boot.

## Contract

Same optional-binary shape as blake3-napi: per-arch artifact, never
committed, loaded from `bin/talon-fusefs.node` (override:
`TALON_FUSEFS_NODE`; disable: `TALON_NO_FUSEFS=1`). Missing or broken
addon = the FUSE layer stays off and `src/core/vfs/fusefs.ts` degrades
to the symlink farm with a logged reason.

Linux-only: fuser is built with `default-features = false` (no libfuse
link — nothing needed at build time) and mounts through
`fusermount3`/`fusermount` at runtime, which is a Linux facility. The
TS lifecycle never attempts a mount elsewhere.

**Deadlock rule** (enforced by convention in `core/vfs/fusefs.ts`): the
daemon process must never perform *synchronous* fs I/O under
`~/.talon/ns` — sync blocks the one JS thread that answers the bridge.
Async fs and child processes are always safe.

## Building

```
npm run build:fusefs                 # host build -> bin/talon-fusefs.node
node native/talon-fusefs/build.mjs --target=<rust-triple>   # cross -> dist/
```

Toolchain pinned by `rust-toolchain.toml` (one Rust pin across the
native plane). CI builds the addon and drives the real artifact through
a live mount in `src/__tests__/fusefs-live.test.ts`.
