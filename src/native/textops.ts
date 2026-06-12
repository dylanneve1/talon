/**
 * Message splitting — TypeScript boundary over the Zig wasm module.
 *
 * One hardened splitter shared by every frontend (Telegram 4096,
 * Discord 2000, Teams adaptive cards), replacing three divergent JS
 * copies. The Zig source lives in native/textops-wasm and exports a
 * three-function C ABI (alloc / dealloc / split_message) — no glue,
 * no runtime. See that crate's README for the full ABI contract and
 * splitting semantics; see src/native/runtime.ts for the embedding
 * and memory conventions shared by every native module.
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
import {
  allocRegion,
  consumeResultTable,
  embeddedWasm,
  toBytes,
  writeRegion,
  type WasmCoreExports,
} from "./runtime.js";

/** flags bit 0: track ``` fences, close/reopen across chunk breaks. */
const FLAG_FENCE_AWARE = 1;

/** The C-ABI surface exported by native/textops-wasm. */
interface TextopsExports extends WasmCoreExports {
  split_message(
    inputPtr: number,
    len: number,
    maxUnits: number,
    flags: number,
  ): number;
}

const textopsWasm = embeddedWasm<TextopsExports>(TEXTOPS_WASM_BASE64);

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
  const wasm = textopsWasm.instance();
  const input = toBytes(text);

  const inputPtr = allocRegion(wasm, input.length, "splitMessage");
  try {
    writeRegion(wasm, inputPtr, input);
    const outPtr = wasm.split_message(inputPtr, input.length, max, flags);
    if (outPtr === 0) {
      throw new Error("splitMessage: wasm allocation failed for result");
    }
    return consumeResultTable(wasm, outPtr);
  } finally {
    wasm.dealloc(inputPtr, input.length);
  }
}
