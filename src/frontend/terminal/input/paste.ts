/** Bracketed paste — accumulate between the start/end markers, then collapse. */

import { ensureTrailingText } from "./parts.js";
import { redraw } from "./render.js";
import type { InputState } from "./state.js";

const PASTE_COLLAPSE_LINES = 3;
const PASTE_COLLAPSE_CHARS = 150;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function handlePasteComplete(state: InputState, text: string): void {
  const lineCount = text.split("\n").length;
  if (lineCount >= PASTE_COLLAPSE_LINES || text.length > PASTE_COLLAPSE_CHARS) {
    // Collapse into a paste part
    state.parts.push({ type: "paste", content: text });
  } else {
    // Short paste — inline into current text part
    ensureTrailingText(state.parts).content += text.replace(/\n/g, " ");
  }
  state.history.detach(state.parts);
  redraw(state);
}

/**
 * Feed a stdin chunk to the paste accumulator. Returns true when the chunk
 * belonged to a paste (started one, continued one, or finished one) and so
 * must not reach the key dispatcher.
 */
export function consumePasteChunk(state: InputState, chunk: string): boolean {
  if (chunk.includes(PASTE_START)) {
    state.inPaste = true;
    state.pasteAccum = chunk.split(PASTE_START).slice(1).join(PASTE_START);
    if (state.pasteAccum.includes(PASTE_END)) {
      state.inPaste = false;
      handlePasteComplete(state, state.pasteAccum.split(PASTE_END)[0]!);
      state.pasteAccum = "";
    }
    return true;
  }
  if (state.inPaste) {
    if (chunk.includes(PASTE_END)) {
      state.pasteAccum += chunk.split(PASTE_END)[0]!;
      state.inPaste = false;
      handlePasteComplete(state, state.pasteAccum);
      state.pasteAccum = "";
    } else {
      state.pasteAccum += chunk;
    }
    return true;
  }
  return false;
}
