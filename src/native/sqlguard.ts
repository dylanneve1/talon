/**
 * SQL input hardening — TypeScript boundary over the C wasm module.
 *
 * Two escapers for the model/attacker-controlled text the history tools
 * splice into SQLite queries: `escapeLike` builds the `%fragment%`
 * pattern for a LIKE search (get_user_messages), and `ftsQuote` turns
 * free-form text into a literal FTS5 MATCH expression (search_history).
 *
 * The Rust source lives in native/sqlguard-wasm and exports a four-function
 * C ABI (alloc / dealloc / escape_like / fts_quote) — see that module's
 * README for the contract, and src/native/runtime.ts for the embedding
 * and memory conventions shared by every native module.
 *
 * Output is byte-identical to the JavaScript these replace (verified by
 * the differential property test in
 * src/__tests__/native-sqlguard.test.ts): the transforms are byte-local,
 * so multi-byte UTF-8 passes through opaquely and never collides with the
 * ASCII metacharacters being escaped.
 */

import {
  allocRegion,
  embeddedWasm,
  toBytes,
  writeRegion,
  type WasmCoreExports,
} from "./runtime.js";
import { SQLGUARD_WASM_BASE64 } from "./sqlguard-wasm-bytes.js";

/** The C-ABI surface exported by native/sqlguard-wasm. */
interface SqlguardExports extends WasmCoreExports {
  escape_like(inputPtr: number, len: number): number;
  fts_quote(inputPtr: number, len: number): number;
}

const sqlguardWasm = embeddedWasm<SqlguardExports>(SQLGUARD_WASM_BASE64);

// BOM-preserving decoder. The shared consumeResultTable() uses a default
// TextDecoder, which strips a leading U+FEFF — that would diverge from the
// JS these escapers replace (which pass a leading BOM straight into the SQL
// value). We decode the single-item result table here instead so the output
// is byte-identical. ignoreBOM:true affects only a leading BOM; interior
// U+FEFF decodes normally either way.
const DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

/** Stage `input`, run a single-string-returning export, decode + free. */
function runOne(
  call: (wasm: SqlguardExports, ptr: number, len: number) => number,
  what: string,
  input: Uint8Array,
): string {
  const wasm = sqlguardWasm.instance();
  const inputPtr = allocRegion(wasm, input.length, what);
  try {
    writeRegion(wasm, inputPtr, input);
    const outPtr = call(wasm, inputPtr, input.length);
    if (outPtr === 0) {
      throw new Error(`${what}: wasm allocation failed for result`);
    }
    // Decode result-table item 0 (count is always 1 for these exports).
    let total = 0;
    try {
      const view = new DataView(wasm.memory.buffer);
      total = view.getUint32(outPtr, true);
      const len = view.getUint32(outPtr + 8, true);
      // Copy out before dealloc (and before the decoder runs).
      const bytes = new Uint8Array(
        wasm.memory.buffer,
        outPtr + 12,
        len,
      ).slice();
      return DECODER.decode(bytes);
    } finally {
      wasm.dealloc(outPtr, total);
    }
  } finally {
    wasm.dealloc(inputPtr, input.length);
  }
}

/**
 * Escape the SQL LIKE wildcards in `text` for an `ESCAPE '\'` clause
 * (`\ -> \\`, `% -> \%`, `_ -> \_`), so a user-supplied fragment can be
 * wrapped as `%fragment%` without `%`/`_` acting as wildcards. Lowercases
 * first — full-Unicode case folding stays in TS — then escapes the
 * (ASCII) metacharacters in the native core.
 */
export function escapeLike(text: string): string {
  const lowered = text.toLowerCase();
  // Fast path: nothing to escape, skip the boundary round-trip.
  if (!/[\\%_]/.test(lowered)) return lowered;
  return runOne(
    (w, p, l) => w.escape_like(p, l),
    "escapeLike",
    toBytes(lowered),
  );
}

/**
 * Build an FTS5 MATCH expression from free-form `query`: every
 * whitespace-delimited token is double-quoted (interior `"` doubled) so
 * FTS operators (AND, NEAR, *, ^) in user text are treated as literals,
 * not syntax. Empty / all-whitespace input yields an empty string.
 */
export function ftsQuote(query: string): string {
  return runOne((w, p, l) => w.fts_quote(p, l), "ftsQuote", toBytes(query));
}
