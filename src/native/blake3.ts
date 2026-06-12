/**
 * BLAKE3 content hashing — TypeScript boundary over the Rust wasm module.
 *
 * First brick of the Rust data/indexing plane: fast, collision-resistant
 * content hashes for media dedupe. The Rust crate lives in
 * native/blake3-wasm and exports a raw C ABI — alloc / dealloc /
 * blake3_hash for one-shot hashing plus hasher_new / hasher_update /
 * hasher_finalize / hasher_free for streaming — no wasm-bindgen, no JS
 * glue. See that crate's README for the full ABI contract, and
 * src/native/runtime.ts for the embedding and memory conventions
 * shared by every native module.
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
import {
  allocRegion,
  embeddedWasm,
  toBytes,
  writeRegion,
  type WasmCoreExports,
} from "./runtime.js";

/** BLAKE3 digest length in bytes (fixed by the wasm ABI). */
const HASH_LEN = 32;

/**
 * Streaming chunk size for blake3HexFile. One scratch region of this
 * size is allocated per call, so peak wasm memory is bounded by the
 * chunk size — not the file size — no matter how large the file.
 */
const FILE_CHUNK_BYTES = 1024 * 1024;

/** The C-ABI surface exported by native/blake3-wasm. */
interface Blake3Exports extends WasmCoreExports {
  blake3_hash(inputPtr: number, len: number, outPtr: number): void;
  /** Returns an opaque handle (0 on exhaustion); consume with finalize/free. */
  hasher_new(): number;
  hasher_update(handle: number, inputPtr: number, len: number): void;
  /** Writes the 32-byte digest and consumes the handle. */
  hasher_finalize(handle: number, outPtr: number): void;
  /** Consumes the handle without a digest (error cleanup). */
  hasher_free(handle: number): void;
}

const blake3Wasm = embeddedWasm<Blake3Exports>(BLAKE3_WASM_BASE64);

/**
 * Hash bytes (or the UTF-8 encoding of a string) with BLAKE3.
 * Returns the 64-char lowercase hex digest.
 */
export async function blake3Hex(data: Uint8Array | string): Promise<string> {
  const input = toBytes(data);
  const wasm = await blake3Wasm.load();

  // Allocate both regions BEFORE taking any memory views (runtime.ts
  // convention: alloc may grow linear memory and detach views).
  const inputPtr = allocRegion(wasm, input.length, "blake3Hex");
  let outPtr = 0;
  try {
    outPtr = allocRegion(wasm, HASH_LEN, "blake3Hex digest");
    writeRegion(wasm, inputPtr, input);
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
  const wasm = await blake3Wasm.load();
  const handle = wasm.hasher_new();
  if (handle === 0) {
    throw new Error("blake3HexFile: wasm hasher allocation failed");
  }
  let finalized = false;
  let scratch = 0;
  try {
    scratch = allocRegion(wasm, FILE_CHUNK_BYTES, "blake3HexFile scratch");
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
    const outPtr = allocRegion(wasm, HASH_LEN, "blake3HexFile digest");
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
