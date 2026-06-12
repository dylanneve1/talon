/**
 * HTML entity escaping — TypeScript boundary over the C++ wasm module.
 *
 * One single-pass escaper for Telegram HTML parse mode, replacing the
 * five chained regex passes it supersedes. Every outbound Telegram
 * render flows through here (frontend/telegram/formatting.ts). The C++
 * source lives in native/htmlents-cpp and exports a three-function
 * C ABI (alloc / dealloc / escape_html) — see that module's README for
 * the contract, and src/native/runtime.ts for the embedding and memory
 * conventions shared by every native module.
 *
 * Escapes exactly what the JS implementation did, in HTML-attribute-
 * safe form: & < > " '. Everything else (including multi-byte UTF-8)
 * passes through untouched.
 */

import { HTMLENTS_WASM_BASE64 } from "./htmlents-wasm-bytes.js";
import {
  allocRegion,
  consumeResultTable,
  embeddedWasm,
  toBytes,
  writeRegion,
  type WasmCoreExports,
} from "./runtime.js";

/** The C-ABI surface exported by native/htmlents-cpp. */
interface HtmlentsExports extends WasmCoreExports {
  escape_html(inputPtr: number, len: number): number;
}

const htmlentsWasm = embeddedWasm<HtmlentsExports>(HTMLENTS_WASM_BASE64);

/**
 * Escape HTML special characters (& < > " ') for HTML parse mode.
 * Must be applied to all text that is NOT inside an HTML tag.
 */
export function escapeHtml(text: string): string {
  // Fast path: nothing to escape, skip the boundary round-trip. The
  // scan is the same test the wasm side would do, without the copies.
  if (!/[&<>"']/.test(text)) return text;

  const wasm = htmlentsWasm.instance();
  const input = toBytes(text);
  const inputPtr = allocRegion(wasm, input.length, "escapeHtml");
  try {
    writeRegion(wasm, inputPtr, input);
    const outPtr = wasm.escape_html(inputPtr, input.length);
    if (outPtr === 0) {
      throw new Error("escapeHtml: wasm allocation failed for result");
    }
    return consumeResultTable(wasm, outPtr)[0];
  } finally {
    wasm.dealloc(inputPtr, input.length);
  }
}
