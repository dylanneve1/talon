# talon-driver

The native launcher that fronts the Talon CLI for the binary
distribution channels — apt `.deb`, Homebrew bottle, source install.
Packaging ships this per-arch executable as `talon`; it finds a usable
Node, then hands off to the existing JS entry so there is exactly one
startup code path.

Written in C and compiled with the pinned Zig toolchain (`zig cc`,
`native/.zig-version`) so it cross-compiles per arch with the same
driver as the rest of the native plane. (Zig was the first choice, but
Zig 0.16's process API is mid-refactor into the new `Io` interface with
no stable `execv`; a launcher this load-bearing wants the boring,
decades-stable POSIX calls.)

POSIX-only by design: the native-binary channels are apt (Linux) and
Homebrew (macOS). Windows keeps using the portable `bin/talon.js` npm
shim, so there is no `execv`/`fork` to emulate there.

## What it does

1. **Resolve the JS entry** next to itself — `talon.js` beside the
   launcher, then `../bin/talon.js`, then `../lib/talon/bin/talon.js`.
   `TALON_JS` overrides.
2. **Resolve Node >= 24.** If `TALON_NODE` is set it is authoritative
   (used exactly, never overridden by a search). Otherwise, in priority
   order:

   ```
   <self>/vendor/node → <self>/node → $PATH
     → /usr/local/bin, /usr/bin, /opt/homebrew/bin, /opt/local/bin, /snap/bin
     → $NVM_BIN/node, $VOLTA_HOME/bin/node
   ```

   The first candidate that exists and reports major >= 24 wins. The
   `vendor/node` step is what lets a `.deb`/bottle bundle its own Node.
3. **Hand off** via `execv(node, ["node", talon.js, ...args])` — the
   launcher *becomes* node, so signals, exit codes, and `ps` all pass
   straight through.
4. **Diagnose** misses on stderr with a non-zero exit: no Node found
   (install hints), only an old Node (reports the version it saw), or a
   missing JS entry.

The Node version probe runs `node --version` via `fork` + `execl` (no
shell), so a node path with spaces or shell metacharacters is never
reinterpreted.

## Build

```sh
npm run build:driver          # host build → bin/talon
npm run build:driver:all      # x86_64/aarch64 × linux-musl/macos → dist/
node build.mjs --target=x86_64-linux-musl   # one cross target
```

Linux targets use musl, so `zig cc` emits a static binary with no libc
dependency — one file that runs across distros. The binary is not
committed (it is per-arch); `bin/talon.js` remains the npm entry point.

## Tests

`src/__tests__/talon-driver.test.ts` builds the launcher and drives the
real binary against fake `node`/`talon.js` (exit + argv pass-through,
the `TALON_NODE` override, version-floor rejection, PATH discovery,
entry resolution). The suite skips when zig is absent; the CI Driver job
builds and runs it with the pinned toolchain.
