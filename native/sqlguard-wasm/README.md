# sqlguard-wasm

SQL input-hardening cores in Rust, compiled to `wasm32-unknown-unknown`
(`no_std`, toolchain pinned in `rust-toolchain.toml`). Two byte-local
escapers for the model/attacker-controlled text that the history tools
splice into SQLite queries.

TypeScript consumer: `src/native/sqlguard.ts` (used by
`src/storage/repositories/history-repo.ts` and `src/storage/history.ts`).
Embedded artifact of record: `src/native/sqlguard-wasm-bytes.ts` (rebuilt
+ diffed by CI). Output is byte-identical to the JavaScript it replaced —
guaranteed by the differential test in
`src/__tests__/native-sqlguard.test.ts`.

## ABI

Linear-memory C ABI, no imports. `alloc` / `dealloc` come from the shared
allocator (`native/shared/walloc.rs`); see `src/native/runtime.ts` for the
conventions every native module shares. Both entry points return the
shared length-prefixed result table (u32 LE): `[0]` total buffer size
(pass back to `dealloc`), `[1]` item count (always 1), `[2]` produced byte
length, then the bytes. Both return 0 on allocation failure.

- `escape_like(in_ptr, in_len) -> ptr`
  Escape the SQL LIKE wildcards for an `ESCAPE '\'` clause: `\ -> \\`,
  `% -> \%`, `_ -> \_`. Every other byte (including all multi-byte UTF-8)
  passes through untouched. Callers lowercase first — full-Unicode case
  folding stays in TypeScript.

- `fts_quote(in_ptr, in_len) -> ptr`
  Build an FTS5 `MATCH` expression: split the input on JS-`\s` whitespace
  (a fixed set matched as whole UTF-8 byte sequences — no decoder),
  drop empty tokens, wrap each token in `"` and double any interior `"`,
  and join tokens with a single space. FTS operators (`AND`, `NEAR`, `*`,
  `^`) in user text are thereby treated as literals. Empty / all-
  whitespace input yields a zero-length result.

## Build

```sh
npm run build:wasm  # cargo → sqlguard_wasm.wasm → src/native/sqlguard-wasm-bytes.ts
```
