# strsim-c

String-similarity core in C, compiled to `wasm32-freestanding` with the
pinned Zig toolchain (`zig cc`, pin in `native/.zig-version`). Powers
"did you mean ...?" suggestions for unknown Telegram slash commands and
unknown CLI subcommands.

TypeScript consumer: `src/native/strsim.ts`. Embedded artifact of
record: `src/native/strsim-wasm-bytes.ts` (rebuilt + diffed by CI).

## ABI

Linear-memory C ABI, no imports. `alloc` / `dealloc` come from the
shared allocator (`native/shared/walloc.h`); see
`src/native/runtime.ts` for the conventions every native module shares.

- `levenshtein(a_ptr, a_len, b_ptr, b_len) -> u32`
  Levenshtein edit distance over the raw bytes of the two regions.
  Either pointer may be 0 only when its length is 0. Returns
  `0xFFFFFFFF` when either length exceeds 1024 bytes (the static DP
  row) — the wrapper maps that to a thrown error (`levenshtein`) or a
  skipped candidate (`closestMatch`).

Distance is byte-based: for the ASCII identifiers this module exists
for, byte distance equals character distance.

## Build

```sh
npm run build:c     # zig cc → strsim.wasm → src/native/strsim-wasm-bytes.ts
```
