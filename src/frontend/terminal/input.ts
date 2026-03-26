/**
 * Terminal input — raw stdin with manual key parsing.
 *
 * Input is a list of parts: text segments and collapsed paste blocks.
 * You can type, paste, type more, paste again. Backspace removes from the end.
 * Enter submits everything. Ctrl+U clears all.
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

type TextPart = { type: "text"; content: string };
type PastePart = { type: "paste"; content: string };
type Part = TextPart | PastePart;

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

  // Input is an ordered list of parts
  let parts: Part[] = [{ type: "text", content: "" }];

  // Bracketed paste accumulation
  let inPaste = false;
  let pasteAccum = "";

  // ── Helpers ──

  function lastPart(): Part {
    return parts[parts.length - 1]!;
  }

  /** Ensure the last part is a text part (for typing into). */
  function ensureTrailingText(): TextPart {
    const last = lastPart();
    if (last.type === "text") return last;
    const t: TextPart = { type: "text", content: "" };
    parts.push(t);
    return t;
  }

  function pasteTag(p: PastePart): string {
    const lines = p.content.split("\n").length;
    return lines > 1
      ? `[Pasted ~${lines} lines]`
      : `[Pasted ${p.content.length} chars]`;
  }

  // ── Drawing ──
  // Single line only — if content exceeds terminal width, truncate from left
  // so the cursor (end of input) stays visible. No wrapping, no multi-line mess.

  function redraw(): void {
    const cols = process.stdout.columns || 80;
    const promptVis = 4; // "  ❯ " visible width

    // Build the visible content (no ANSI) and the display content (with ANSI)
    const segments: { vis: string; display: string }[] = [];
    for (const p of parts) {
      if (p.type === "text") {
        segments.push({ vis: p.content, display: p.content });
      } else {
        const tag = pasteTag(p);
        segments.push({ vis: tag, display: pc.dim(tag) });
      }
    }

    let vis = segments.map((s) => s.vis).join("");
    let display = segments.map((s) => s.display).join("");

    // Truncate from the left if too long
    const maxContent = cols - promptVis - 1; // leave 1 char margin
    if (vis.length > maxContent) {
      // Find how much to chop — work backwards through segments
      const ellipsis = "…";
      let chop = vis.length - maxContent + 1; // +1 for ellipsis
      let truncDisplay = "";
      let truncVis = "";

      // Build from the end, skipping chopped chars
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i]!;
        if (chop <= 0) {
          truncVis = seg.vis + truncVis;
          truncDisplay = seg.display + truncDisplay;
        } else if (chop < seg.vis.length) {
          // Partial chop from this segment
          if (seg.vis === seg.display) {
            // Text segment — chop visible chars
            truncVis = seg.vis.slice(chop) + truncVis;
            truncDisplay = seg.display.slice(chop) + truncDisplay;
          } else {
            // Paste tag — keep or drop entirely
            truncVis = truncVis;
            truncDisplay = truncDisplay;
          }
          chop = 0;
        } else {
          chop -= seg.vis.length;
        }
      }

      vis = ellipsis + truncVis;
      display = ellipsis + truncDisplay;
    }

    process.stdout.write(`\x1b[2K\r${promptStr}${display}`);
  }

  function getFullText(): string {
    return parts
      .map((p) => p.content)
      .join("\n")
      .trim();
  }

  function clear(): void {
    parts = [{ type: "text", content: "" }];
  }

  function submit(): void {
    const text = getFullText();
    clear();
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
      // Collapse into a paste part
      parts.push({ type: "paste", content: text });
    } else {
      // Short paste — inline into current text part
      ensureTrailingText().content += text.replace(/\n/g, " ");
    }
    redraw();
  }

  function handleBackspace(): void {
    const last = lastPart();
    if (last.type === "text" && last.content.length > 0) {
      // Delete last char from text
      last.content = last.content.slice(0, -1);
    } else if (
      last.type === "text" &&
      last.content === "" &&
      parts.length > 1
    ) {
      // Empty trailing text — remove it, then remove the paste before it
      parts.pop();
      parts.pop();
      // Ensure we always have at least one text part
      if (parts.length === 0) parts.push({ type: "text", content: "" });
      ensureTrailingText();
    } else if (last.type === "paste") {
      // Remove the paste block
      parts.pop();
      if (parts.length === 0) parts.push({ type: "text", content: "" });
      ensureTrailingText();
    }
    redraw();
  }

  // ── Raw mode ──

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?2004h");

  process.stdin.on("data", (chunk: string) => {
    if (paused) return;

    // ── Bracketed paste ──
    if (chunk.includes(PASTE_START)) {
      inPaste = true;
      pasteAccum = chunk.split(PASTE_START).slice(1).join(PASTE_START);
      if (pasteAccum.includes(PASTE_END)) {
        inPaste = false;
        handlePasteComplete(pasteAccum.split(PASTE_END)[0]!);
        pasteAccum = "";
      }
      return;
    }
    if (inPaste) {
      if (chunk.includes(PASTE_END)) {
        pasteAccum += chunk.split(PASTE_END)[0]!;
        inPaste = false;
        handlePasteComplete(pasteAccum);
        pasteAccum = "";
      } else {
        pasteAccum += chunk;
      }
      return;
    }

    // ── Normal input ──
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      const code = chunk.charCodeAt(i);

      if (code === 0x03) {
        // Ctrl+C
        process.stdout.write("\n\x1b[?2004l");
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.exit(0);
      }

      if (code === 0x15) {
        // Ctrl+U
        clear();
        redraw();
        continue;
      }

      if (code === 0x0d || code === 0x0a) {
        // Enter
        if (getFullText()) {
          submit();
        } else {
          process.stdout.write("\n");
          redraw();
        }
        continue;
      }

      if (code === 0x7f || code === 0x08) {
        // Backspace
        handleBackspace();
        continue;
      }

      if (code === 0x1b) {
        // Escape sequence — skip
        if (i + 1 < chunk.length && chunk[i + 1] === "[") {
          i += 2;
          while (i < chunk.length && chunk.charCodeAt(i) < 0x40) i++;
        }
        continue;
      }

      if (code === 0x09) {
        // Tab
        ensureTrailingText().content += "  ";
        redraw();
        continue;
      }

      if (code < 0x20) continue;

      // Printable char
      ensureTrailingText().content += ch;
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
