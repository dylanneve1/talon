/**
 * String similarity — TypeScript boundary over the C wasm module.
 *
 * Powers "did you mean ...?" suggestions for unknown Telegram slash
 * commands and unknown CLI subcommands. The C source lives in
 * native/strsim-c and exports a three-function C ABI (alloc / dealloc /
 * levenshtein) — see that module's README for the contract, and
 * src/native/runtime.ts for the embedding and memory conventions
 * shared by every native module.
 *
 * Distance is computed over UTF-8 bytes. For the ASCII identifiers
 * this module exists for (command names, subcommands, model ids) byte
 * distance equals character distance; non-ASCII text weighs a
 * substituted codepoint as up to 4 edits, which still ranks fine.
 *
 * Strings longer than 1024 bytes come back as the wasm overflow
 * sentinel: `levenshtein` throws, `closestMatch` skips the candidate.
 */

import { STRSIM_WASM_BASE64 } from "./strsim-wasm-bytes.js";
import {
  allocRegion,
  embeddedWasm,
  toBytes,
  writeRegion,
  type WasmCoreExports,
} from "./runtime.js";

/** Returned by the wasm side when either input exceeds its DP buffer. */
const OVERFLOW = 0xffffffff;

/** The C-ABI surface exported by native/strsim-c. */
interface StrsimExports extends WasmCoreExports {
  levenshtein(aPtr: number, aLen: number, bPtr: number, bLen: number): number;
}

const strsimWasm = embeddedWasm<StrsimExports>(STRSIM_WASM_BASE64);

function rawDistance(a: Uint8Array, b: Uint8Array): number {
  const wasm = strsimWasm.instance();
  // Allocate both regions BEFORE writing either (runtime.ts convention:
  // alloc may grow linear memory and detach views).
  const aPtr = allocRegion(wasm, a.length, "levenshtein");
  let bPtr = 0;
  try {
    bPtr = allocRegion(wasm, b.length, "levenshtein");
    writeRegion(wasm, aPtr, a);
    writeRegion(wasm, bPtr, b);
    // wasm i32 return crosses as signed; >>> 0 restores the sentinel.
    return wasm.levenshtein(aPtr, a.length, bPtr, b.length) >>> 0;
  } finally {
    wasm.dealloc(bPtr, b.length);
    wasm.dealloc(aPtr, a.length);
  }
}

/**
 * Levenshtein edit distance between two strings (UTF-8 byte edits).
 * Throws for inputs longer than the wasm module's 1024-byte ceiling —
 * identifiers, not documents.
 */
export function levenshtein(a: string, b: string): number {
  const distance = rawDistance(toBytes(a), toBytes(b));
  if (distance === OVERFLOW) {
    throw new Error("levenshtein: input exceeds 1024 bytes");
  }
  return distance;
}

export interface ClosestMatch {
  value: string;
  distance: number;
}

/**
 * The candidate closest to `input` by edit distance, or null when none
 * comes within `maxDistance`. Ties keep the first candidate. Matching
 * is case-insensitive (identifiers like /Doctor vs /doctor); the
 * returned `value` keeps the candidate's original casing. Candidates
 * (or an input) beyond the 1024-byte ceiling are skipped, not errors.
 */
export function closestMatch(
  input: string,
  candidates: readonly string[],
  maxDistance = 2,
): ClosestMatch | null {
  const inputBytes = toBytes(input.toLowerCase());
  let best: ClosestMatch | null = null;
  for (const candidate of candidates) {
    const distance = rawDistance(inputBytes, toBytes(candidate.toLowerCase()));
    if (distance === OVERFLOW) continue;
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { value: candidate, distance };
      if (distance === 0) break;
    }
  }
  return best;
}
