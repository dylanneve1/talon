/**
 * Terminal input handler — readline wrapper with paste detection.
 *
 * Paste detection: when multiple "line" events fire within 50ms (as happens
 * during paste), they're buffered and submitted as a single message.
 *
 * Long pastes (>50 chars or multi-line) are collapsed into a compact
 * [Pasted N lines (X chars)] indicator. Backspace deletes the whole paste.
 * Like Claude Code's paste behavior.
 */

import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import pc from "picocolors";

// ── Types ────────────────────────────────────────────────────────────────────

export type InputHandler = {
  readonly rl: ReadlineInterface;
  onLine(callback: (text: string) => void): void;
  prompt(): void;
  waitForInput(): Promise<string>;
  close(): void;
};

// ── Constants ────────────────────────────────────────────────────────────────

const PASTE_DEBOUNCE_MS = 50;
const PASTE_COLLAPSE_THRESHOLD = 50; // chars — collapse pastes longer than this

// ── Factory ──────────────────────────────────────────────────────────────────

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

  // Pending paste state — when a paste is collapsed into [Pasted ...],
  // the full text is stored here. Next Enter submits it, backspace clears it.
  let pendingPasteText: string | null = null;

  /** Erase N visual lines upward (for clearing wrapped readline echo). */
  function eraseLines(count: number): void {
    for (let i = 0; i < count; i++) {
      process.stdout.write("\x1b[2K"); // clear line
      if (i < count - 1) process.stdout.write("\x1b[A"); // move up
    }
    process.stdout.write("\r"); // return to column 0
  }

  /** Show the paste indicator, clearing any echoed text first. */
  function showPasteIndicator(text: string): void {
    const lines = text.split("\n").length;
    const chars = text.length;
    const label =
      lines > 1
        ? `[Pasted ${lines} lines (${chars} chars)]`
        : `[Pasted ${chars} chars]`;

    // Calculate how many visual lines readline echoed (prompt + text wrapping)
    const termCols = process.stdout.columns || 80;
    const promptLen = 4; // "  ❯ " visible length
    let visualLines = 0;
    for (const line of text.split("\n")) {
      visualLines += Math.max(
        1,
        Math.ceil((line.length + promptLen) / termCols),
      );
    }
    eraseLines(visualLines);

    process.stdout.write(`${promptStr}${pc.dim(label)}`);
  }

  rl.on("line", (raw) => {
    // If we had a pending paste and the user just pressed Enter (empty line),
    // submit the pending paste text.
    if (pendingPasteText !== null && raw === "") {
      const text = pendingPasteText;
      pendingPasteText = null;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(text);
      } else if (lineCallback) {
        lineCallback(text);
      }
      return;
    }

    // If we had a pending paste but user typed something new, discard the
    // pending paste and treat this as fresh input.
    if (pendingPasteText !== null) {
      pendingPasteText = null;
    }

    pasteLines.push(raw);

    if (pasteTimer) {
      clearTimeout(pasteTimer);
    } else {
      // First line — hide prompt so subsequent pasted lines don't show ❯
      rl.setPrompt("");
    }

    pasteTimer = setTimeout(() => {
      const text = pasteLines.join("\n").trim();
      pasteLines = [];
      pasteTimer = null;
      rl.setPrompt(promptStr);

      if (!text) return;

      const isMultiLine = text.includes("\n");
      const isLong = text.length > PASTE_COLLAPSE_THRESHOLD;

      if (isMultiLine || isLong) {
        // Collapse: clear the echoed mess and show a compact indicator.
        // Store the full text — Enter submits, backspace clears.
        pendingPasteText = text;
        showPasteIndicator(text);
        // Don't submit yet — wait for Enter to confirm.
        return;
      }

      // Short single-line input — submit immediately (normal behavior).
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(text);
        return;
      }

      if (lineCallback) lineCallback(text);
    }, PASTE_DEBOUNCE_MS);
  });

  // Handle keypress for backspace-to-clear-paste
  if (process.stdin.isTTY) {
    process.stdin.on("keypress", (_ch: string, key: { name?: string }) => {
      if (!key) return;
      if (pendingPasteText !== null && key.name === "backspace") {
        // Clear the whole paste
        pendingPasteText = null;
        eraseLines(1);
        rl.setPrompt(promptStr);
        process.stdout.write(promptStr);
      }
    });
  }

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
