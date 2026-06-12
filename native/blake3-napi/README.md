# blake3-napi

BLAKE3 media hashing as an in-process **napi-rs addon** — the third
delivery shape in the native plane. Embedded wasm modules are the
portable floor, real executables (talon-driver, talon-warden) own
process-model work, and a `.node` library is the shape for CPU-bound
work that should stay *in* the Node process but wants everything the
wasm sandbox can't give: native SIMD, threads, and direct fs access.

This crate is the same BLAKE3 the wasm twin
([blake3-wasm](../blake3-wasm/)) embeds, built for the host instead of
`wasm32-unknown-unknown`. What that buys on the media-dedupe path
(`src/storage/media-index.ts`, hashing every downloaded file):

| | blake3-wasm (fallback) | blake3-napi |
| --- | --- | --- |
| Kernel | portable scalar | runtime SIMD (AVX-512/AVX2/SSE, NEON) + rayon |
| Input | copied chunk-by-chunk into linear memory | hashed in place / memory-mapped |
| Event loop | blocked for the whole hash | file hashing on the libuv pool |
| 50 MB file | hundreds of ms, on-loop | ~10 ms, off-loop |

## Surface

napi-derive camelCases the Rust names on the JS side:

```ts
version(): string                            // crate version, for doctor
hashHex(data: Buffer): string                // one-shot, in place
hashFileHex(path: string): Promise<string>   // mmap + rayon, off the event loop
```

`hashHex` runs on the calling thread (rayon kicks in past 128 KiB);
`hashFileHex` is an `AsyncTask` on the libuv thread pool and rejects on
fs errors, matching the wasm streaming path's throw semantics.

## Contract with the boundary

`src/native/blake3.ts` resolves `bin/talon-blake3.node` (override:
`TALON_BLAKE3_NODE`; disable: `TALON_NO_BLAKE3_NATIVE=1`), verifies the
empty-input digest at load time, and silently falls back to the
embedded wasm module on any failure — same optional-artifact contract
as the warden. The native registry's blake3 self-test stays pinned to
the **wasm** export so doctor keeps vouching for the embedded bytes
even when the addon is installed; doctor reports the addon separately.

## Building

```sh
npm run build:napi                            # host build → bin/talon-blake3.node
node native/blake3-napi/build.mjs --target=<t>  # cross → native/blake3-napi/dist/
```

Toolchain pinned by `rust-toolchain.toml` (same pin as blake3-wasm and
talon-warden). The artifact is never committed; per-arch builds ship
through the binary channels and `npm run build:napi` covers source
installs. Plain npm installs run without it on the wasm fallback.

## Testing

- `cargo test` — hashing kernels (known vector, rayon/serial agreement,
  file vs buffer agreement, fs error propagation).
- `src/__tests__/blake3-napi.test.ts` — builds the real `.node` with the
  pinned toolchain and drives it through the TS boundary: digest
  agreement with wasm across input shapes and files, fallback when
  disabled/missing/bogus, and an event-loop-responsiveness check while
  hashing 64 MB. Skips when cargo is absent; the CI Napi job is the
  build of record.
