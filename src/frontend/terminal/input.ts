/**
 * Terminal input — raw stdin with manual key parsing.
 *
 * Input is a list of parts: text segments and collapsed paste blocks.
 * You can type, paste, type more, paste again. Backspace removes from the end.
 * Enter submits everything. Ctrl+U clears all. Up/Down walk prompt history.
 *
 * State lives in `input/state.ts`; paste, keys and drawing are each their own
 * module under `input/`. This file is the wiring.
 */

import { createInputState } from "./input/state.js";
import { consumePasteChunk } from "./input/paste.js";
import { handleKeyChunk } from "./input/keys.js";
import { redraw } from "./input/render.js";

export type { InputPart } from "./input/parts.js";
export { PromptHistory } from "./input/history.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type InputHandler = {
  onLine(callback: (text: string) => void): void;
  prompt(): void;
  waitForInput(): Promise<string>;
  close(): void;
  pause(): void;
  resume(): void;
};

// ── Factory ──────────────────────────────────────────────────────────────────

export function createInput(promptStr: string): InputHandler {
  const state = createInputState(promptStr);

  // ── Raw mode ──

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?2004h");

  process.stdin.on("data", (chunk: string) => {
    if (state.paused) return;
    if (consumePasteChunk(state, chunk)) return;
    handleKeyChunk(state, chunk);
  });

  return {
    onLine(callback) {
      state.lineCallback = callback;
    },
    prompt() {
      state.paused = false;
      state.prevRows = 1; // fresh prompt = 1 row
      redraw(state);
    },
    waitForInput(): Promise<string> {
      return new Promise((resolve) => {
        state.pendingResolve = resolve;
        state.paused = false;
        state.prevRows = 1;
        redraw(state);
      });
    },
    pause() {
      state.paused = true;
    },
    resume() {
      state.paused = false;
    },
    close() {
      if (state.pendingResolve) {
        const resolve = state.pendingResolve;
        state.pendingResolve = null;
        resolve("");
      }
      process.stdout.write("\x1b[?2004l");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    },
  };
}
