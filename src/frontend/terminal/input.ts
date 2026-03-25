/**
 * Terminal input handler — readline wrapper with paste detection.
 *
 * Paste detection: when multiple "line" events fire within 50ms (as happens
 * during paste), they're buffered and submitted as a single message.
 * The prompt is hidden after the first line so pasted content doesn't show
 * duplicate ❯ prefixes.
 */

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

// ── Types ────────────────────────────────────────────────────────────────────

export type InputHandler = {
  readonly rl: ReadlineInterface;
  onLine(callback: (text: string) => void): void;
  prompt(): void;
  waitForInput(): Promise<string>;
  close(): void;
};

// ── Factory ──────────────────────────────────────────────────────────────────

const PASTE_DEBOUNCE_MS = 50;

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

    if (pasteTimer) {
      // Continuation of a paste — timer already running
      clearTimeout(pasteTimer);
    } else {
      // First line — hide prompt so subsequent pasted lines don't show ❯
      rl.setPrompt("");
    }

    pasteTimer = setTimeout(() => {
      const text = pasteLines.join("\n").trim();
      pasteLines = [];
      pasteTimer = null;
      rl.setPrompt(promptStr); // restore prompt

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
