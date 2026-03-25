/**
 * Terminal input — raw stdin with manual key parsing.
 *
 * No readline, no emitKeypressEvents. We read raw data from stdin and
 * parse keys + escape sequences ourselves. This gives us full control
 * over bracketed paste detection and avoids all readline/keypress bugs.
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

  // Input buffer
  let buffer = "";

  // Paste state
  let inPaste = false;
  let pasteBuffer = "";
  let pendingPaste: string | null = null; // collapsed paste awaiting Enter/Backspace

  // ── Drawing ──

  function redraw(): void {
    let display: string;
    if (pendingPaste !== null) {
      const lines = pendingPaste.split("\n").length;
      const label =
        lines > 1
          ? `[Pasted ~${lines} lines]`
          : `[Pasted ${pendingPaste.length} chars]`;
      display = `${promptStr}${pc.dim(label)}`;
    } else {
      display = `${promptStr}${buffer}`;
    }
    process.stdout.write(`\x1b[2K\r${display}`);
  }

  function submit(text: string): void {
    // For collapsed paste: prepend any text typed before the paste
    const full = prePasteBuffer ? prePasteBuffer + "\n" + text : text;
    buffer = "";
    pendingPaste = null;
    prePasteBuffer = "";
    process.stdout.write("\n");

    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(full);
      return;
    }
    if (lineCallback) lineCallback(full);
  }

  function clearPaste(): void {
    pendingPaste = null;
    buffer = prePasteBuffer;
    prePasteBuffer = "";
    redraw();
  }

  // ── Raw mode ──

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  // Enable bracketed paste
  process.stdout.write("\x1b[?2004h");

  process.stdin.on("data", (chunk: string) => {
    if (paused) return;

    // ── Bracketed paste handling ──
    // Check if this chunk contains paste markers
    if (chunk.includes(PASTE_START)) {
      inPaste = true;
      // Content may follow the start marker in the same chunk
      pasteBuffer = chunk.split(PASTE_START).slice(1).join(PASTE_START);
      // Check if end marker is also in this chunk (small paste)
      if (pasteBuffer.includes(PASTE_END)) {
        const text = pasteBuffer.split(PASTE_END)[0]!;
        inPaste = false;
        pasteBuffer = "";
        handlePasteComplete(text);
      }
      return;
    }

    if (inPaste) {
      if (chunk.includes(PASTE_END)) {
        pasteBuffer += chunk.split(PASTE_END)[0]!;
        const text = pasteBuffer;
        inPaste = false;
        pasteBuffer = "";
        handlePasteComplete(text);
      } else {
        pasteBuffer += chunk;
      }
      return;
    }

    // ── Normal input — process each byte/char ──
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      const code = chunk.charCodeAt(i);

      // Ctrl+C (0x03)
      if (code === 0x03) {
        process.stdout.write("\n");
        process.stdout.write("\x1b[?2004l");
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }

      // Ctrl+U (0x15) — clear line
      if (code === 0x15) {
        clearPaste();
        continue;
      }

      // Enter (0x0D \r or 0x0A \n)
      if (code === 0x0d || code === 0x0a) {
        if (pendingPaste !== null) {
          submit(pendingPaste);
        } else if (buffer.trim()) {
          submit(buffer);
        } else {
          process.stdout.write("\n");
          redraw();
        }
        continue;
      }

      // Backspace (0x7F or 0x08)
      if (code === 0x7f || code === 0x08) {
        if (pendingPaste !== null) {
          clearPaste();
        } else if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          redraw();
        }
        continue;
      }

      // Escape sequence — skip until end
      if (code === 0x1b) {
        // Consume the rest of the escape sequence
        if (i + 1 < chunk.length && chunk[i + 1] === "[") {
          i += 2; // skip \x1b[
          while (i < chunk.length && chunk.charCodeAt(i) < 0x40) i++; // params
          // i now points at the final byte — the loop increment skips it
        }
        continue;
      }

      // Tab (0x09) — insert spaces or ignore
      if (code === 0x09) {
        if (pendingPaste !== null) continue;
        buffer += "  ";
        redraw();
        continue;
      }

      // Ignore other control chars
      if (code < 0x20) continue;

      // Regular printable character
      if (pendingPaste !== null) {
        // Typing after paste: restore pre-paste text + new char
        pendingPaste = null;
        buffer = prePasteBuffer + ch;
        prePasteBuffer = "";
      } else {
        buffer += ch;
      }
      redraw();
    }
  });

  // Buffer saved before a collapsed paste, restored on backspace
  let prePasteBuffer = "";

  function handlePasteComplete(text: string): void {
    const lineCount = text.split("\n").length;
    if (
      lineCount >= PASTE_COLLAPSE_LINES ||
      text.length > PASTE_COLLAPSE_CHARS
    ) {
      // Collapse — save current buffer so backspace can restore it
      prePasteBuffer = buffer;
      pendingPaste = text;
      buffer = "";
      redraw();
    } else {
      // Short paste — append inline to existing buffer
      buffer += text.replace(/\n/g, " ");
      pendingPaste = null;
      redraw();
    }
  }

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
