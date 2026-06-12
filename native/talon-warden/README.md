# talon-warden

Rust supervision harness for trigger children — the second real
executable in the native plane (beside [talon-driver](../talon-driver/)),
and the first where the *process model*, not just the code, is the
point. Where the driver fronts the CLI, the warden fronts every trigger
script the bot writes: `triggers.ts` spawns one warden per trigger, and
the warden owns the child's whole lifecycle.

## Why a separate process

Supervising children from inside the Node event loop has three
structural gaps:

1. **Kills miss grandchildren.** `child.kill()` signals one pid. A bash
   script that left `sleep 9999 &` behind leaks it past every
   cancel/timeout/shutdown path. The warden starts the child in its own
   process group (child as leader) and signals the whole group.
2. **Deadlines ride the event loop.** A wedged or SIGSTOPped Talon
   stops enforcing trigger timeouts. The warden enforces
   TERM → grace → KILL against the group out of process.
3. **A SIGKILLed Talon reaps nothing.** Orphaned triggers used to run
   until the next boot's best-effort PID probe. The warden watches for
   parent death — `PR_SET_PDEATHSIG` on Linux, ppid-change polling
   everywhere, EPIPE on the event pipe as the backstop — and tears the
   tree down itself. Children additionally get their own pdeathsig on
   Linux, so even a SIGKILLed *warden* doesn't leak the tree.

Policy stays in TypeScript: TALON_FIRE parsing, status transitions,
wake prompts, and the persistent-trigger contract all live in
`src/core/background/triggers.ts`, fed by the event stream below. The
warden is plumbing only, and `triggers.ts` falls back to its original
in-process path when the binary is absent (plain npm installs, Windows,
`TALON_NO_WARDEN=1`).

## Invocation

```sh
talon-warden --timeout-ms=300000 [--grace-ms=5000] [--max-line-bytes=8192] \
             -- <cmd> [args...]
talon-warden --version
```

- `--timeout-ms=0` disables the deadline (persistent triggers).
- `--grace-ms` is the TERM → KILL escalation window, used for the
  deadline, forwarded signals, and parent-death teardown alike.
- The child runs with stdin null, the warden's env (Talon injects
  `TALON_TRIGGER_*` there), and the warden's cwd.

Warden exit codes: `0` supervised to completion (whatever the child
did), `2` usage error, `3` spawn failure, `1` internal/pipe failure.

## Event protocol (NDJSON on stdout)

One JSON object per line; `src/native/warden.ts` is the consuming
boundary:

```json
{"event":"start","pid":123,"pidStarttime":456}
{"event":"line","stream":"stdout","text":"…","truncated":false}
{"event":"exit","code":0,"signal":null,"timedOut":false,"reason":"exited","durationMs":42}
{"event":"error","message":"spawn failed: …"}
```

- `start` — child spawned. `pidStarttime` is field 22 of
  `/proc/<pid>/stat` (jiffies since boot, Linux; null elsewhere) — the
  same PID-reuse defence `triggers.ts` keeps for orphan probing.
- `line` — one child output line, in arrival order across both
  streams. Lines are capped at `--max-line-bytes` *bytes*; overflow is
  dropped and flagged `truncated`. The cap never splits a multi-byte
  UTF-8 sequence, and invalid bytes are lossy-converted.
- `exit` — exactly one terminal event per run (or `error` when the
  child never spawned). `code`/`signal` describe how the *child* died;
  `reason` says why supervision ended: `exited` (the child's own exit),
  `timeout` (warden deadline; also sets `timedOut`), `signal`
  (SIGTERM/SIGINT/SIGHUP forwarded from the parent), or `parent-exit`
  (Talon died).

Teardown discipline: when the run ends — child exit, deadline,
forwarded signal, or parent death — the warden SIGKILLs whatever is
left of the process group, so a completed trigger never leaves
background descendants. Mid-escalation signals to the warden are
forwarded as TERM to the group first; the group only ever dies
escalated, never silently.

## Building

```sh
npm run build:warden                              # host build → bin/talon-warden
node native/talon-warden/build.mjs --target=<t>   # cross → native/talon-warden/dist/
```

The toolchain is pinned by `rust-toolchain.toml` (same pin as
blake3-wasm — one Rust pin for the whole plane). The binary is never
committed; per-arch builds ship through the same channels as the
launcher. Cross targets need `rustup target add` first; macOS builds
run on macOS runners (no zig-style cross-sysroot).

## Testing

- `cargo test` — pure-function units (arg parsing, JSON escaping,
  UTF-8-safe truncation, `/proc` stat parsing, line framing).
- `src/__tests__/talon-warden.test.ts` — builds the real binary with
  the pinned toolchain and drives it end-to-end: protocol framing,
  exit/signal reporting, group kills reaching grandchildren, SIGTERM
  forwarding, parent-death teardown, byte caps. Skips when cargo is
  absent; the CI Warden job is the build of record.
- `src/__tests__/triggers.test.ts` + `triggers-extended.test.ts` run
  the full trigger supervisor over the warden path whenever
  `bin/talon-warden` exists (and the TS fallback path under
  `TALON_NO_WARDEN=1`).
