/**
 * Terminal input — raw stdin with manual key parsing.
 *
 * No readline, no emitKeypressEvents. Raw data from stdin, parsed manually.
 * Bracketed paste mode for proper paste detection.
 */

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
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// ── Factory ──────────────────────────────────────────────────────────────────

export function createInput(promptStr: string): InputHandler {
  let lineCallback: ((text: string) => void) | null = null;
  let pendingResolve: ((value: string) => void) | null = null;
  let paused = false;

  // The full input is: buffer + (optional collapsed paste attachment)
  // buffer    = text the user has typed (visible, editable)
  // pastePart = collapsed paste content (shown as dim [Pasted ...] tag after buffer)
  // Backspace when cursor is at end of buffer+paste removes the paste first.
  let buffer = "";
  let pastePart: string | null = null; // non-null = paste attached

  // Bracketed paste accumulation
  let inPaste = false;
  let pasteAccum = "";

  // ── Drawing ──

  function redraw(): void {
    let display = `${promptStr}${buffer}`;
    if (pastePart !== null) {
      const lines = pastePart.split("\n").length;
      const tag =
        lines > 1
          ? `[Pasted ~${lines} lines]`
          : `[Pasted ${pastePart.length} chars]`;
      display += ` ${pc.dim(tag)}`;
    }
    process.stdout.write(`\x1b[2K\r${display}`);
  }

  function getFullText(): string {
    if (pastePart !== null) {
      return buffer ? `${buffer}\n${pastePart}` : pastePart;
    }
    return buffer;
  }

  function submit(): void {
    const text = getFullText();
    buffer = "";
    pastePart = null;
    process.stdout.write("\n");

    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(text);
      return;
    }
    if (lineCallback) lineCallback(text);
  }

  function handlePasteComplete(text: string): void {
    const lineCount = text.split("\n").length;
    if (
      lineCount >= PASTE_COLLAPSE_LINES ||
      text.length > PASTE_COLLAPSE_CHARS
    ) {
      // Collapse — attach to current buffer (buffer stays as-is)
      pastePart = text;
    } else {
      // Short paste — inline into buffer
      buffer += text.replace(/\n/g, " ");
    }
    redraw();
  }

  // ── Raw mode ──

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?2004h"); // enable bracketed paste

  process.stdin.on("data", (chunk: string) => {
    if (paused) return;

    // ── Bracketed paste ──
    if (chunk.includes(PASTE_START)) {
      inPaste = true;
      pasteAccum = chunk.split(PASTE_START).slice(1).join(PASTE_START);
      if (pasteAccum.includes(PASTE_END)) {
        const text = pasteAccum.split(PASTE_END)[0]!;
        inPaste = false;
        pasteAccum = "";
        handlePasteComplete(text);
      }
      return;
    }
    if (inPaste) {
      if (chunk.includes(PASTE_END)) {
        pasteAccum += chunk.split(PASTE_END)[0]!;
        const text = pasteAccum;
        inPaste = false;
        pasteAccum = "";
        handlePasteComplete(text);
      } else {
        pasteAccum += chunk;
      }
      return;
    }

    // ── Normal input ──
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      const code = chunk.charCodeAt(i);

      // Ctrl+C
      if (code === 0x03) {
        process.stdout.write("\n\x1b[?2004l");
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }

      // Ctrl+U — clear everything
      if (code === 0x15) {
        buffer = "";
        pastePart = null;
        redraw();
        continue;
      }

      // Enter
      if (code === 0x0d || code === 0x0a) {
        const text = getFullText();
        if (text.trim()) {
          submit();
        } else {
          process.stdout.write("\n");
          redraw();
        }
        continue;
      }

      // Backspace
      if (code === 0x7f || code === 0x08) {
        if (pastePart !== null) {
          // Remove the paste attachment, keep buffer
          pastePart = null;
          redraw();
        } else if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          redraw();
        }
        continue;
      }

      // Escape sequence — skip
      if (code === 0x1b) {
        if (i + 1 < chunk.length && chunk[i + 1] === "[") {
          i += 2;
          while (i < chunk.length && chunk.charCodeAt(i) < 0x40) i++;
        }
        continue;
      }

      // Tab
      if (code === 0x09) {
        buffer += "  ";
        redraw();
        continue;
      }

      // Other control chars — ignore
      if (code < 0x20) continue;

      // Printable character — always appends to buffer
      buffer += ch;
      redraw();
    }
  });

  return {
    onLine(callback) {
      lineCallback = callback;
    },
    prompt() {
      paused = false;
      redraw();
    },
    waitForInput(): Promise<string> {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        paused = false;
        redraw();
      });
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    close() {
      process.stdout.write("\x1b[?2004l");
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    },
  };
}
