/** Drawing — rewrite the prompt line(s) in place. */

import pc from "picocolors";
import type { PastePart } from "./parts.js";
import type { InputState } from "./state.js";

function pasteTag(p: PastePart): string {
  const lines = p.content.split("\n").length;
  return lines > 1
    ? `[Pasted ~${lines} lines]`
    : `[Pasted ${p.content.length} chars]`;
}

/**
 * Track how many visual rows the last render occupied.
 * Move up to the first row, clear to end of screen, rewrite.
 */
export function redraw(state: InputState): void {
  const cols = process.stdout.columns || 80;

  // Build display string and measure visible length (strip ANSI)
  let display = state.promptStr;
  let visLen = 4; // "  ❯ " = 4 visible chars
  for (const p of state.parts) {
    if (p.type === "text") {
      display += p.content;
      visLen += p.content.length;
    } else {
      const tag = pasteTag(p);
      display += pc.dim(tag);
      visLen += tag.length;
    }
  }

  // Move cursor to start of the previous render, clear to end of screen
  if (state.prevRows > 1) {
    process.stdout.write(`\x1b[${state.prevRows - 1}A`); // move up
  }
  process.stdout.write(`\r\x1b[J${display}\x1b[?25h`); // col 0, clear to EOS, write, show cursor

  state.prevRows = Math.max(1, Math.ceil(visLen / cols));
}
