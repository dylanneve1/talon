/**
 * Terminal input handler — readline wrapper with paste detection.
 *
 * Paste detection uses a 15ms debounce: pasted multi-line content fires
 * rapid "line" events that get buffered and submitted as a single message.
 */

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

// ── Types ────────────────────────────────────────────────────────────────────

export type InputHandler = {
  readonly rl: ReadlineInterface;
  /** Register the main line callback (only one at a time). */
  onLine(callback: (text: string) => void): void;
  /** Show the prompt. */
  prompt(): void;
  /** Wait for a single line of input (for interactive follow-ups like /resume). */
  waitForInput(): Promise<string>;
  /** Tear down. */
  close(): void;
};

// ── Factory ──────────────────────────────────────────────────────────────────

const PASTE_DEBOUNCE_MS = 15;

export function createInput(promptStr: string): InputHandler {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptStr,
  });

  let lineCallback: ((text: string) => void) | null = null;
  let pasteLines: string[] = [];
  let pasteTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingResolve: ((value: string) => void) | null = null;

  rl.on("line", (raw) => {
    pasteLines.push(raw);
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => {
      const text = pasteLines.join("\n").trim();
      pasteLines = [];
      pasteTimer = null;

      // If waitForInput() is pending, resolve it
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(text);
        return;
      }

      if (lineCallback) lineCallback(text);
    }, PASTE_DEBOUNCE_MS);
  });

  return {
    rl,

    onLine(callback) {
      lineCallback = callback;
    },

    prompt() {
      rl.prompt();
    },

    waitForInput(): Promise<string> {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        rl.prompt();
      });
    },

    close() {
      rl.close();
    },
  };
}
