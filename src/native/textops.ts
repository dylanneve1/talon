/**
 * Message splitting — TypeScript boundary over the Zig wasm module.
 *
 * One hardened splitter shared by every frontend (Telegram 4096,
 * Discord 2000, Teams adaptive cards), replacing three divergent JS
 * copies. The Zig source lives in native/textops-wasm and exports a
 * three-function C ABI (alloc / dealloc / split_message) — no glue,
 * no runtime. See that crate's README for the full ABI contract and
 * splitting semantics.
 *
 * The wasm bytes are embedded as base64 (./textops-wasm-bytes.ts) so
 * this module works identically under node, tsx, bun, and
 * `bun build --compile` single binaries — no fs paths or
 * import.meta.url asset resolution, which compiled binaries cannot
 * serve.
 *
 * Instantiation is synchronous (the module is ~3KB) so splitMessage
 * keeps the plain sync signature the frontend call sites expect.
 *
 * Memory discipline: every call allocates its input, splits, copies
 * the chunks out, and deallocates both regions before returning.
 * Nothing is held across calls (verified by the repeated-call test in
 * src/__tests__/textops-wasm.test.ts).
 */

import { TEXTOPS_WASM_BASE64 } from "./textops-wasm-bytes.js";

/** flags bit 0: track ``` fences, close/reopen across chunk breaks. */
const FLAG_FENCE_AWARE = 1;

/** The C-ABI surface exported by native/textops-wasm. */
interface TextopsExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  split_message(
    inputPtr: number,
    len: number,
    maxUnits: number,
    flags: number,
  ): number;
}

let cachedExports: TextopsExports | null = null;

/**
 * Lazily instantiate the embedded wasm module exactly once. Deferring
 * keeps module import side-effect free for consumers that never split.
 */
function getExports(): TextopsExports {
  if (!cachedExports) {
    const wasmBytes = Buffer.from(TEXTOPS_WASM_BASE64, "base64");
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBytes),
      {},
    );
    cachedExports = instance.exports as unknown as TextopsExports;
  }
  return cachedExports;
}

export interface SplitOptions {
  /**
   * Track ``` code fences: a chunk that would strand an open fence is
   * closed with "\n```" and the next chunk reopens with "```\n", so
   * every chunk renders as complete markup on its own. Default true.
   */
  fenceAware?: boolean;
}

/**
 * Split `text` into chunks of at most `maxUnits` UTF-16 code units
 * (what platform character limits and JS `.length` measure), preferring
 * paragraph, then newline, then space boundaries, never splitting
 * inside a surrogate pair. A text that already fits comes back as a
 * single untouched chunk.
 */
export function splitMessage(
  text: string,
  maxUnits: number,
  options: SplitOptions = {},
): string[] {
  const max = Math.max(1, Math.floor(maxUnits));
  const flags = (options.fenceAware ?? true) ? FLAG_FENCE_AWARE : 0;
  const wasm = getExports();
  const input = new TextEncoder().encode(text);

  // Allocate before taking any memory views: alloc may grow linear
  // memory, which detaches existing ArrayBuffer views.
  const inputPtr = wasm.alloc(input.length); // 0 (null) when input is empty
  if (inputPtr === 0 && input.length > 0) {
    throw new Error(
      `splitMessage: wasm allocation failed for ${input.length}-byte input`,
    );
  }
  let outPtr = 0;
  let outLen = 0;
  try {
    if (input.length > 0) {
      new Uint8Array(wasm.memory.buffer, inputPtr, input.length).set(input);
    }
    outPtr = wasm.split_message(inputPtr, input.length, max, flags);
    if (outPtr === 0) {
      throw new Error("splitMessage: wasm allocation failed for result");
    }
    // Views are created after the call — split_message may also grow
    // linear memory.
    const view = new DataView(wasm.memory.buffer);
    outLen = view.getUint32(outPtr, true);
    const count = view.getUint32(outPtr + 4, true);
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let offset = outPtr + 4 * (2 + count);
    for (let i = 0; i < count; i++) {
      const len = view.getUint32(outPtr + 4 * (2 + i), true);
      chunks.push(
        decoder.decode(new Uint8Array(wasm.memory.buffer, offset, len)),
      );
      offset += len;
    }
    return chunks;
  } finally {
    wasm.dealloc(inputPtr, input.length);
    wasm.dealloc(outPtr, outLen);
  }
}
