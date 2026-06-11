/**
 * BLAKE3 content hashing — TypeScript boundary over the Rust wasm module.
 *
 * First brick of the Rust data/indexing plane: fast, collision-resistant
 * content hashes for media dedupe. The Rust crate lives in
 * native/blake3-wasm and exports a three-function C ABI (alloc / dealloc /
 * blake3_hash) — no wasm-bindgen, no JS glue. See that crate's README for
 * the full ABI contract.
 *
 * The wasm bytes are embedded as base64 (./blake3-wasm-bytes.ts) so this
 * module works identically under node, tsx, bun, and `bun build --compile`
 * single binaries — no fs paths or import.meta.url asset resolution, which
 * compiled binaries cannot serve.
 *
 * Memory discipline: every call allocates its input + output regions,
 * copies, hashes, and deallocates before returning. There are no awaits
 * between alloc and dealloc, so concurrent callers cannot interleave
 * inside a hash and nothing leaks across calls (verified by the
 * repeated-call test in src/__tests__/blake3-wasm.test.ts).
 */

import { readFile, stat } from "node:fs/promises";
import { BLAKE3_WASM_BASE64 } from "./blake3-wasm-bytes.js";

/** BLAKE3 digest length in bytes (fixed by the wasm ABI). */
const HASH_LEN = 32;

/**
 * blake3HexFile reads whole files (v1 keeps the wasm ABI one-shot rather
 * than threading incremental hasher state across the boundary). 256MB is
 * a generous ceiling for the media-dedupe use case while bounding worst
 * case memory at roughly 2x file size (node buffer + wasm linear memory).
 * Larger files are refused loudly instead of OOMing quietly; lift this by
 * adding an incremental ABI (hasher_new/update/finalize) in a later rev.
 */
export const BLAKE3_MAX_FILE_BYTES = 256 * 1024 * 1024;

/** The C-ABI surface exported by native/blake3-wasm. */
interface Blake3Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  blake3_hash(inputPtr: number, len: number, outPtr: number): void;
}

let exportsPromise: Promise<Blake3Exports> | null = null;

/**
 * Lazily instantiate the embedded wasm module exactly once. Decoding
 * ~29KB of base64 and compiling the module is microseconds of work, but
 * deferring it keeps module import side-effect free for consumers that
 * never hash.
 */
function getExports(): Promise<Blake3Exports> {
  if (!exportsPromise) {
    const wasmBytes = Buffer.from(BLAKE3_WASM_BASE64, "base64");
    exportsPromise = WebAssembly.instantiate(wasmBytes, {}).then(
      (result) => result.instance.exports as unknown as Blake3Exports,
    );
  }
  return exportsPromise;
}

/**
 * Hash bytes (or the UTF-8 encoding of a string) with BLAKE3.
 * Returns the 64-char lowercase hex digest.
 */
export async function blake3Hex(data: Uint8Array | string): Promise<string> {
  const input =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const wasm = await getExports();

  // Allocate both regions BEFORE taking any memory views: alloc may grow
  // linear memory, which detaches existing ArrayBuffer views.
  const inputPtr = wasm.alloc(input.length); // 0 (null) when input is empty
  const outPtr = wasm.alloc(HASH_LEN);
  // alloc returns 0 on allocator exhaustion (and for len 0, which is fine
  // for the input). Never write through a null pointer — offset 0 is the
  // module's data section.
  if (outPtr === 0 || (inputPtr === 0 && input.length > 0)) {
    wasm.dealloc(inputPtr, input.length);
    throw new Error(
      `blake3Hex: wasm allocation failed for ${input.length}-byte input`,
    );
  }
  try {
    if (input.length > 0) {
      new Uint8Array(wasm.memory.buffer, inputPtr, input.length).set(input);
    }
    wasm.blake3_hash(inputPtr, input.length, outPtr);
    // Copy the digest out of linear memory before dealloc reclaims it.
    return Buffer.from(wasm.memory.buffer, outPtr, HASH_LEN).toString("hex");
  } finally {
    wasm.dealloc(inputPtr, input.length);
    wasm.dealloc(outPtr, HASH_LEN);
  }
}

/**
 * Hash a file's contents with BLAKE3. Reads the whole file into memory;
 * refuses files larger than BLAKE3_MAX_FILE_BYTES (see the constant's doc
 * for the rationale and the planned incremental-ABI lift).
 */
export async function blake3HexFile(path: string): Promise<string> {
  const { size } = await stat(path);
  if (size > BLAKE3_MAX_FILE_BYTES) {
    throw new Error(
      `blake3HexFile: ${path} is ${size} bytes, over the ${BLAKE3_MAX_FILE_BYTES}-byte one-shot limit`,
    );
  }
  return blake3Hex(await readFile(path));
}
