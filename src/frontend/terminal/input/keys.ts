/**
 * Key dispatch — one handler per control code. Anything not in the table is
 * either a stray control character (dropped) or a printable one (typed).
 */

import { ensureTrailingText, lastPart } from "./parts.js";
import { redraw } from "./render.js";
import { clearInput, fullText, submitInput, type InputState } from "./state.js";

/**
 * Handles the key at `chunk[i]`. Returns the index of the last byte it
 * consumed, so a multi-byte escape sequence can skip its tail.
 */
type KeyHandler = (state: InputState, chunk: string, i: number) => number;

function insertText(state: InputState, text: string): void {
  ensureTrailingText(state.parts).content += text;
  state.history.detach(state.parts);
  redraw(state);
}

function navigateHistory(
  state: InputState,
  direction: "previous" | "next",
): void {
  const recalled = state.history.move(direction, state.parts);
  if (!recalled) return;
  state.parts = recalled;
  redraw(state);
}

function onCtrlC(): number {
  process.stdout.write("\n\x1b[?2004l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

function onCtrlU(state: InputState, _chunk: string, i: number): number {
  clearInput(state);
  redraw(state);
  return i;
}

function onEnter(state: InputState, _chunk: string, i: number): number {
  if (fullText(state)) {
    submitInput(state);
  } else {
    process.stdout.write("\n");
    redraw(state);
  }
  return i;
}

function onBackspace(state: InputState, _chunk: string, i: number): number {
  const parts = state.parts;
  const last = lastPart(parts);
  if (last.type === "text" && last.content.length > 0) {
    // Delete last char from text
    last.content = last.content.slice(0, -1);
  } else if (last.type === "text" && last.content === "" && parts.length > 1) {
    // Empty trailing text — remove it, then remove the paste before it
    parts.pop();
    parts.pop();
    // Ensure we always have at least one text part
    if (parts.length === 0) parts.push({ type: "text", content: "" });
    ensureTrailingText(parts);
  } else if (last.type === "paste") {
    // Remove the paste block
    parts.pop();
    if (parts.length === 0) parts.push({ type: "text", content: "" });
    ensureTrailingText(parts);
  }
  state.history.detach(parts);
  redraw(state);
  return i;
}

function onEscape(state: InputState, chunk: string, i: number): number {
  if (i + 1 < chunk.length && chunk[i + 1] === "[") {
    // CSI escape sequence. Up/Down navigate history; the rest are
    // ignored until cursor editing is implemented.
    let end = i + 2;
    while (end < chunk.length && chunk.charCodeAt(end) < 0x40) end++;
    const final = chunk[end];
    if (final === "A") navigateHistory(state, "previous");
    if (final === "B") navigateHistory(state, "next");
    return end;
  }
  if (
    i + 2 < chunk.length &&
    chunk[i + 1] === "O" &&
    (chunk[i + 2] === "A" || chunk[i + 2] === "B")
  ) {
    // Some terminals use application-cursor sequences (ESC O A/B).
    navigateHistory(state, chunk[i + 2] === "A" ? "previous" : "next");
    return i + 2;
  }
  if (state.pendingResolve) {
    // Bare Escape during waitForInput — cancel
    const resolve = state.pendingResolve;
    state.pendingResolve = null;
    clearInput(state);
    process.stdout.write("\n");
    resolve("");
  }
  return i;
}

function onTab(state: InputState, _chunk: string, i: number): number {
  insertText(state, "  ");
  return i;
}

/** Control code → handler. Enter and Backspace each answer to two codes. */
export const KEY_HANDLERS: Record<number, KeyHandler> = Object.assign(
  Object.create(null),
  {
    0x03: onCtrlC, // Ctrl+C
    0x15: onCtrlU, // Ctrl+U
    0x0d: onEnter, // Enter (CR)
    0x0a: onEnter, // Enter (LF)
    0x7f: onBackspace, // Backspace (DEL)
    0x08: onBackspace, // Backspace (BS)
    0x1b: onEscape, // Escape / CSI
    0x09: onTab, // Tab
  },
);

/** Normal (non-paste) input: dispatch each key in the chunk. */
export function handleKeyChunk(state: InputState, chunk: string): void {
  for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i);
    const handler = KEY_HANDLERS[code];
    if (handler) {
      i = handler(state, chunk, i);
      continue;
    }
    if (code < 0x20) continue;

    // Printable char
    insertText(state, chunk[i]!);
  }
}
