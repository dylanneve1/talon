/**
 * BLAKE3 content hashing — TypeScript boundary over the Rust wasm module.
 *
 * First brick of the Rust data/indexing plane: fast, collision-resistant
 * content hashes for media dedupe. The Rust crate lives in
 * native/blake3-wasm and exports a raw C ABI — alloc / dealloc /
 * blake3_hash for one-shot hashing plus hasher_new / hasher_update /
 * hasher_finalize / hasher_free for streaming — no wasm-bindgen, no JS
 * glue. See that crate's README for the full ABI contract.
 *
 * The wasm bytes are embedded as base64 (./blake3-wasm-bytes.ts) so this
 * module works identically under node, tsx, bun, and `bun build --compile`
 * single binaries — no fs paths or import.meta.url asset resolution, which
 * compiled binaries cannot serve.
 *
 * Memory discipline: every call allocates its own regions (and, for
 * files, its own hasher handle), and releases them before returning —
 * on the error path too. One-shot hashes have no awaits between alloc
 * and dealloc; streaming hashes await file reads but their state is
 * per-handle, so concurrent callers stay independent and nothing leaks
 * across calls (verified by the repeated-call and interleaving tests in
 * src/__tests__/blake3-wasm.test.ts).
 */

import { createReadStream } from "node:fs";
import { BLAKE3_WASM_BASE64 } from "./blake3-wasm-bytes.js";

/** BLAKE3 digest length in bytes (fixed by the wasm ABI). */
const HASH_LEN = 32;

/**
 * Streaming chunk size for blake3HexFile. One scratch region of this
 * size is allocated per call, so peak wasm memory is bounded by the
 * chunk size — not the file size — no matter how large the file.
 */
const FILE_CHUNK_BYTES = 1024 * 1024;

/** The C-ABI surface exported by native/blake3-wasm. */
interface Blake3Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  blake3_hash(inputPtr: number, len: number, outPtr: number): void;
  /** Returns an opaque handle (0 on exhaustion); consume with finalize/free. */
  hasher_new(): number;
  hasher_update(handle: number, inputPtr: number, len: number): void;
  /** Writes the 32-byte digest and consumes the handle. */
  hasher_finalize(handle: number, outPtr: number): void;
  /** Consumes the handle without a digest (error cleanup). */
  hasher_free(handle: number): void;
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
 * Hash a file's contents with BLAKE3, streaming through the incremental
 * wasm ABI (hasher_new / hasher_update / hasher_finalize). Peak memory
 * is one FILE_CHUNK_BYTES scratch region regardless of file size — the
 * v1 whole-file read and its 256MB refusal ceiling are gone.
 *
 * Interleaving safety: file reads await between updates, but each call
 * owns its hasher handle and its scratch region, so concurrent hashes
 * cannot corrupt each other. The scratch view into linear memory is
 * re-created per chunk because another caller's alloc may grow memory
 * and detach existing views; hasher_update itself never allocates.
 */
export async function blake3HexFile(path: string): Promise<string> {
  const wasm = await getExports();
  const handle = wasm.hasher_new();
  if (handle === 0) {
    throw new Error("blake3HexFile: wasm hasher allocation failed");
  }
  let finalized = false;
  const scratch = wasm.alloc(FILE_CHUNK_BYTES);
  if (scratch === 0) {
    wasm.hasher_free(handle);
    throw new Error("blake3HexFile: wasm scratch allocation failed");
  }
  try {
    const stream = createReadStream(path, {
      highWaterMark: FILE_CHUNK_BYTES,
    });
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      // Chunks arrive ≤ highWaterMark, but slice defensively so a
      // larger-than-expected buffer can never overrun the scratch region.
      for (let off = 0; off < bytes.length; off += FILE_CHUNK_BYTES) {
        const slice = bytes.subarray(off, off + FILE_CHUNK_BYTES);
        new Uint8Array(wasm.memory.buffer, scratch, slice.length).set(slice);
        wasm.hasher_update(handle, scratch, slice.length);
      }
    }
    const outPtr = wasm.alloc(HASH_LEN);
    if (outPtr === 0) {
      throw new Error("blake3HexFile: wasm digest allocation failed");
    }
    try {
      wasm.hasher_finalize(handle, outPtr);
      finalized = true;
      return Buffer.from(wasm.memory.buffer, outPtr, HASH_LEN).toString("hex");
    } finally {
      wasm.dealloc(outPtr, HASH_LEN);
    }
  } finally {
    wasm.dealloc(scratch, FILE_CHUNK_BYTES);
    if (!finalized) wasm.hasher_free(handle);
  }
}
