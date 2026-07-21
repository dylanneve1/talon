# htmlents-wasm

HTML entity escaping in Rust, compiled to `wasm32-unknown-unknown`
(`no_std`, toolchain pinned in `rust-toolchain.toml`). One single-pass
escaper for Telegram HTML parse mode — every outbound Telegram render
flows through it — replacing five chained regex passes in JS.

TypeScript consumer: `src/native/htmlents.ts` (used by
`frontend/telegram/formatting.ts`). Embedded artifact of record:
`src/native/htmlents-wasm-bytes.ts` (rebuilt + diffed by CI).

## ABI

Linear-memory C ABI, no imports. `alloc` / `dealloc` come from the
shared allocator (`native/shared/walloc.rs`); see
`src/native/runtime.ts` for the conventions every native module shares.

- `escape_html(in_ptr, in_len) -> ptr`
  Escape `& < > " '` in the UTF-8 region (`&amp;` `&lt;` `&gt;`
  `&quot;` `&#39;` — the HTML-attribute-safe set). All other bytes pass
  through untouched (multi-byte UTF-8 never contains ASCII values).
  Returns 0 on allocation failure, otherwise the shared length-prefixed
  result table (u32 LE): `[0]` total buffer size (pass back to
  `dealloc`), `[1]` item count (always 1), `[2]` escaped byte length,
  then the escaped bytes.

## Build

```sh
npm run build:wasm  # cargo → htmlents_wasm.wasm → src/native/htmlents-wasm-bytes.ts
```
