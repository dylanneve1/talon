/**
 * Bun smoke check for the embedded BLAKE3 wasm module.
 *
 * Two jobs, same script:
 *   1. `bun scripts/blake3-smoke.ts` — proves the module works under bun's
 *      runtime (talon's vitest tier runs under node).
 *   2. `bun build --compile scripts/blake3-smoke.ts --outfile <bin>` then
 *      running <bin> — proves the wasm loads from embedded base64 bytes
 *      inside a compiled single binary, where no source tree exists and
 *      fs/import.meta.url asset resolution would fail.
 *
 * Exits 0 and prints "blake3 smoke OK" on success, exits 1 on mismatch.
 * Expected digests come from the official BLAKE3 test vectors
 * (BLAKE3-team/BLAKE3 test_vectors/test_vectors.json).
 */

import { blake3Hex } from "../src/native/blake3.js";

const EMPTY =
  "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
const LEN_1024 =
  "42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7";

const pattern = new Uint8Array(1024);
for (let i = 0; i < pattern.length; i++) pattern[i] = i % 251;

const got = {
  empty: await blake3Hex(""),
  len1024: await blake3Hex(pattern),
};

if (got.empty !== EMPTY || got.len1024 !== LEN_1024) {
  console.error("blake3 smoke FAILED", { got, want: { EMPTY, LEN_1024 } });
  process.exit(1);
}
console.log("blake3 smoke OK", got.empty);
