/**
 * Terminal input — raw stdin mode with bracketed paste detection.
 *
 * No readline. We handle all input ourselves:
 *   - Raw mode for full keyboard control
 *   - Bracketed paste mode (\x1b[200~ ... \x1b[201~) for paste detection
 *   - Long/multi-line pastes collapsed into [Pasted ~N lines]
 *   - Backspace on a paste clears the whole thing
 *   - Ctrl+C to exit, Ctrl+U to clear line
 *
 * This is how Claude Code, OpenCode, and Codex CLI handle input.
 */

import { emitKeypressEvents } from "node:readline";
import pc from "picocolors";

// ── Types ────────────────────────────────────────────────────────────────────

export type InputHandler = {
  onLine(callback: (text: string) => void): void;
  prompt(): void;
  waitForInput(): Promise<string>;
  close(): void;
  pause(): void;
  resume(): void;
};

// ── Constants ────────────────────────────────────────────────────────────────

const PASTE_COLLAPSE_LINES = 3;
const PASTE_COLLAPSE_CHARS = 150;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createInput(promptStr: string): InputHandler {
  let lineCallback: ((text: string) => void) | null = null;
  let pendingResolve: ((value: string) => void) | null = null;
  let paused = false;

  // Input buffer
  let buffer = "";

  // Paste state
  let inBracketedPaste = false;
  let pasteContent = "";
  let hasPendingPaste = false; // paste collapsed, waiting for Enter/Backspace
  let pendingPasteText = ""; // the full paste text

  // ── Drawing ──

  function redrawLine(): void {
    let display: string;
    if (hasPendingPaste) {
      const lines = pendingPasteText.split("\n").length;
      const label =
        lines > 1
          ? `[Pasted ~${lines} lines]`
          : `[Pasted ${pendingPasteText.length} chars]`;
      display = `${promptStr}${pc.dim(label)}`;
    } else {
      display = `${promptStr}${buffer}`;
    }
    process.stdout.write(`\x1b[2K\r${display}`);
  }

  function submit(text: string): void {
    buffer = "";
    hasPendingPaste = false;
    pendingPasteText = "";
    process.stdout.write("\n");

    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(text);
      return;
    }
    if (lineCallback) lineCallback(text);
  }

  // ── Raw mode setup ──

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  emitKeypressEvents(process.stdin);

  // Enable bracketed paste mode
  process.stdout.write("\x1b[?2004h");

  process.stdin.on(
    "keypress",
    (
      str: string | undefined,
      key: {
        name?: string;
        ctrl?: boolean;
        meta?: boolean;
        shift?: boolean;
        sequence?: string;
      },
    ) => {
      if (paused) return;

      const seq = key?.sequence ?? str ?? "";

      // ── Bracketed paste detection ──
      if (seq.includes("\x1b[200~")) {
        inBracketedPaste = true;
        pasteContent = seq.replace("\x1b[200~", "");
        return;
      }
      if (inBracketedPaste) {
        if (seq.includes("\x1b[201~")) {
          // End of paste
          pasteContent += seq.replace("\x1b[201~", "");
          inBracketedPaste = false;

          const text = pasteContent;
          pasteContent = "";
          const lineCount = text.split("\n").length;

          if (
            lineCount >= PASTE_COLLAPSE_LINES ||
            text.length > PASTE_COLLAPSE_CHARS
          ) {
            // Collapse into indicator
            hasPendingPaste = true;
            pendingPasteText = text;
            buffer = "";
            redrawLine();
          } else {
            // Short paste — inline it
            buffer += text.replace(/\n/g, " ");
            redrawLine();
          }
        } else {
          pasteContent += seq;
        }
        return;
      }

      // ── Normal key handling ──

      // Ctrl+C — exit
      if (key?.ctrl && key.name === "c") {
        process.stdout.write("\n");
        // Disable bracketed paste before exit
        process.stdout.write("\x1b[?2004l");
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }

      // Ctrl+U — clear line
      if (key?.ctrl && key.name === "u") {
        buffer = "";
        hasPendingPaste = false;
        pendingPasteText = "";
        redrawLine();
        return;
      }

      // Enter — submit
      if (key?.name === "return") {
        if (hasPendingPaste) {
          submit(pendingPasteText);
        } else if (buffer.trim()) {
          submit(buffer);
        } else {
          // Empty enter — just redraw prompt
          process.stdout.write("\n");
          redrawLine();
        }
        return;
      }

      // Backspace
      if (key?.name === "backspace") {
        if (hasPendingPaste) {
          // Clear entire paste
          hasPendingPaste = false;
          pendingPasteText = "";
          buffer = "";
          redrawLine();
        } else if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          redrawLine();
        }
        return;
      }

      // Ignore special keys (arrows, function keys, etc.)
      // Allow space and tab through (they have multi-char key.name)
      if (
        key?.name &&
        key.name.length > 1 &&
        key.name !== "space" &&
        key.name !== "tab" &&
        !key.ctrl
      )
        return;
      if (key?.ctrl || key?.meta) return;

      // Regular character
      if (str && str.length > 0 && !str.startsWith("\x1b")) {
        if (hasPendingPaste) {
          // Typing after a paste replaces it
          hasPendingPaste = false;
          pendingPasteText = "";
          buffer = str;
        } else {
          buffer += str;
        }
        redrawLine();
      }
    },
  );

  return {
    onLine(callback) {
      lineCallback = callback;
    },

    prompt() {
      paused = false;
      redrawLine();
    },

    waitForInput(): Promise<string> {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        paused = false;
        redrawLine();
      });
    },

    pause() {
      paused = true;
    },

    resume() {
      paused = false;
    },

    close() {
      process.stdout.write("\x1b[?2004l"); // disable bracketed paste
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    },
  };
}
