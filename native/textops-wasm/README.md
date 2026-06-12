# textops-wasm

Message splitting for talon, written in Zig and compiled to
`wasm32-freestanding`. One hardened implementation of "split this reply
into chunks the platform will accept", shared by every frontend — the
consumer-facing API is `src/native/textops.ts` (`splitMessage`), used by
the Telegram (4096), Discord (2000), and Teams (10000) splitters.

## Why a native core

Before this module each frontend carried its own copy of the splitting
loop, and the copies had drifted into distinct bugs:

- **Telegram** had no code-fence handling — a split inside a fenced
  block produced two chunks of broken markup — and its hard-cut path
  could split a surrogate pair in half (`slice` at an arbitrary UTF-16
  index), shipping lone surrogates to the API.
- **Discord** tracked fences by counting raw ``` ` ``` occurrences, so an
  inline triple-backtick run flipped the state machine; and appending
  the close marker could push a chunk past the 2000-char limit.
- **Teams** was a third, slightly different copy with neither feature.

The Zig core fixes all three in one place: fences are tracked
line-by-line (CommonMark-style, up to 3 leading spaces), budget is
reserved for fence markers so decorated chunks never exceed the limit,
hard cuts land on codepoint boundaries, and limits are measured in
UTF-16 code units — what the platforms (and the `String.prototype.length`
arithmetic this replaces) actually count.

## Why Zig via WASM

Same polyglot policy as `native/blake3-wasm` (Rust) and
`native/scheduler-core` (Gleam): new languages only behind clean
boundaries, and `bun build --compile` single-binary installs must keep
working.

- **Clean boundary** — three C-ABI functions over linear memory
  (below). No NAPI, no per-platform prebuilds, no generated glue.
- **Single-binary safe** — the built `.wasm` is embedded as base64 in
  `src/native/textops-wasm-bytes.ts` and instantiated from bytes at
  runtime. No fs paths, no `import.meta.url` asset resolution.
- **No runtime, tiny artifact** — `wasm32-freestanding` with
  `ReleaseSmall` produces a ~3KB module: no allocator shims, no
  language runtime, nothing but the splitter. Zig's lazy compilation
  means the artifact contains exactly the code the three exports reach.
- **Sync instantiation** — at ~3KB the module compiles synchronously
  (`new WebAssembly.Module`), so `splitMessage` stays a plain
  synchronous call, which is what every frontend call site expects.

## ABI contract

The module exports its linear `memory` plus:

| export                                  | contract                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `alloc(len) -> ptr`                     | Allocate `len` bytes, return the offset. Returns `0` for `len == 0` or allocator exhaustion. Region is uninitialized.                                    |
| `dealloc(ptr, len)`                     | Release a region from `alloc` — must pass the **same `len`**. `ptr == 0` or `len == 0` is a no-op.                                                       |
| `split_message(ptr, len, max, flags) -> outPtr` | Split `len` bytes of UTF-8 at `ptr` into chunks of ≤ `max` UTF-16 code units. `flags` bit 0 enables fence tracking. Returns `0` on allocation failure. |

The result buffer at `outPtr` is little-endian u32s then bytes:

```
[0]        total buffer size in bytes — pass back to dealloc(outPtr, total)
[1]        chunk count N
[2..2+N]   byte length of each chunk
then the N chunks' UTF-8 bytes, concatenated
```

Calls are synchronous and stateless between invocations — one instance
is memoized for the process lifetime. Callers must allocate, copy in,
split, copy out, and dealloc with no awaits in between (see
`src/native/textops.ts`).

## Splitting semantics

- A text that already fits is returned as a single untouched chunk.
- Split points prefer `"\n\n"`, then `"\n"`, then `" "`, rejecting
  candidates in the first 30% of the limit (no sliver chunks); last
  resort is a hard cut on a codepoint boundary.
- The remainder is whitespace-trimmed before becoming the next chunk;
  non-final chunk bodies are end-trimmed.
- With fence tracking on, a chunk stranding an open ``` ` ``` fence is
  closed with `"\n```"` and the next chunk reopens with `` "```\n" ``.
- Forward progress is guaranteed even for degenerate limits (a limit
  smaller than one astral codepoint emits one oversize codepoint rather
  than looping).

## Rebuilding

```sh
npm run build:zig
```

That runs, from this directory:

1. `zig build-exe src/textops.zig -target wasm32-freestanding ...`
   (exact flag set in `build.mjs`)
2. the shared embed step (`native/shared/build-lib.mjs`) — regenerates
   `src/native/textops-wasm-bytes.ts`

The generated TS module is the runtime artifact of record and is
committed; the raw `.wasm` is not. The compiler is pinned in
`native/.zig-version` (one pin for every module on the zig toolchain —
Zig, C, and C++) and enforced by `build.mjs`; the zig-toolchain CI job
rebuilds with the pinned toolchain and fails on drift.
