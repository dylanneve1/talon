# Talon native plane

Talon's hot paths and policy cores are written in systems languages and
embedded into the TypeScript runtime. Six embedded modules, three
languages, one contract — plus two real executables (a native launcher
that fronts the CLI, a Rust supervision harness that fronts every
trigger child) and one in-process napi addon for hashing throughput.

| Module | Language | Target | Used by |
| --- | --- | --- | --- |
| [blake3-wasm](blake3-wasm/) | Rust | wasm32-unknown-unknown | media dedupe / content hashing (`src/native/blake3.ts`) |
| [textops-wasm](textops-wasm/) | Zig | wasm32-freestanding | message splitting for every frontend (`src/native/textops.ts`) |
| [strsim-wasm](strsim-wasm/) | Rust | wasm32-unknown-unknown | "did you mean ...?" for Telegram + CLI (`src/native/strsim.ts`) |
| [sqlguard-wasm](sqlguard-wasm/) | Rust | wasm32-unknown-unknown | SQL LIKE / FTS5 escaping for model-controlled input (`src/native/sqlguard.ts`) |
| [htmlents-wasm](htmlents-wasm/) | Rust | wasm32-unknown-unknown | HTML escaping on every Telegram render (`src/native/htmlents.ts`) |
| [scheduler-core](scheduler-core/) | Gleam | JavaScript | cron/heartbeat backoff, breaker, catch-up policy (`src/native/scheduler-core.ts`) |

The launcher and the warden are a different kind of native component —
real executables, not embedded artifacts:

| Component | Language | Target | Role |
| --- | --- | --- | --- |
| [talon-driver](talon-driver/) | C | native per-arch ELF / Mach-O | the `talon` front-door: finds Node >= 24, execs `bin/talon.js` (apt / brew / source installs) |
| [talon-warden](talon-warden/) | Rust | native per-arch ELF / Mach-O | trigger supervision harness: own-process-group children, out-of-process timeouts, orphan-free teardown (`src/native/warden.ts` → `core/background/triggers.ts`, with TS fallback when absent) |

The addon is the third shape — in-process like the wasm modules, but a
real per-arch artifact like the executables, loaded only when present:

| Component | Language | Target | Role |
| --- | --- | --- | --- |
| [blake3-napi](blake3-napi/) | Rust | native per-arch .node (N-API) | media hashing fast path: SIMD + rayon, mmap'd files hashed off the event loop (`src/native/blake3.ts`, embedded-wasm fallback when absent) |

## The contract

- **Embedded artifacts of record.** Builds emit a generated TS module
  under `src/native/` (base64 wasm bytes, or compiled JS for Gleam).
  That file — not a `.wasm` on disk — is what ships: it survives
  `bun build --compile` single binaries and needs no fs paths or
  `import.meta.url` asset resolution.
- **One ABI.** Wasm modules export `memory` / `alloc` / `dealloc` plus
  their entry points; multi-value results use a shared length-prefixed
  table. The TS side of the contract lives in ONE place:
  `src/native/runtime.ts` (lazy instantiation, guarded staging,
  result decoding). The `no_std` Rust modules share the allocator in
  [shared/walloc.rs](shared/walloc.rs).
- **One registry.** Every module declares provenance + a live
  self-test in `src/native/registry.ts`. `talon doctor` and the
  Telegram `/doctor` command iterate that list — a new module shows up
  on every health surface by adding one entry.
- **Pinned, reproducible builds.** Zig builds through the toolchain
  pinned in [.zig-version](.zig-version); Rust pins via per-crate
  `rust-toolchain.toml`; Gleam is pinned in CI. CI rebuilds every
  artifact from source and fails if the committed bytes drift
  (`.github/workflows/ci.yml`).
- **Shared tooling.** Per-module `build.mjs` files are thin manifests
  over [shared/build-lib.mjs](shared/build-lib.mjs) (toolchain pin
  check, deterministic compile flags, embed step).

## Building

Each module only needs its own toolchain:

```sh
npm run build:wasm        # Rust  → blake3, strsim, sqlguard, htmlents
npm run build:zig         # Zig   → textops
npm run build:gleam       # Gleam → scheduler-core
npm run build:native      # all six embedded modules

npm run build:driver      # C launcher → bin/talon (host)
npm run build:driver:all  # launcher cross-compile matrix → dist/
npm run build:warden      # Rust supervision harness → bin/talon-warden (host)
npm run build:napi        # Rust blake3 addon → bin/talon-blake3.node (host)
```

## Adding a module

1. Create `native/<name>/` with sources, a README documenting the ABI,
   and a thin `build.mjs` manifest (see strsim-wasm for the Rust shape).
2. Write the TS boundary in `src/native/<name>.ts` on top of
   `runtime.ts`.
3. Register it in `src/native/registry.ts` with a self-test — doctor
   on every surface picks it up automatically.
4. Wire a real runtime consumer. Native bricks that nothing calls do
   not get merged.
5. Add the rebuild to the matching CI drift job.
