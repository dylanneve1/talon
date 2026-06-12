/**
 * Telegram message formatting and splitting utilities.
 */

import { splitMessage as splitNative } from "../../native/textops.js";

/**
 * Split a message into chunks that fit Telegram's 4096 char limit.
 * Delegates to the shared Zig core (native/textops-wasm): fence-aware
 * — splits never strand an open ``` block — and surrogate-safe, unlike
 * the JS loop this replaces.
 */
export function splitMessage(text: string, max: number): string[] {
  return splitNative(text, max);
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 * Must be applied to all text that is NOT inside an HTML tag.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Convert Markdown output to Telegram-safe HTML.
 *
 * Handles: bold, italic, inline code, fenced code blocks, links.
 * Escapes HTML entities in non-formatted text.
 */
export function markdownToTelegramHtml(text: string): string {
  // Step 1: Extract fenced code blocks to avoid processing their contents.
  // We replace them with placeholders and restore after all inline processing.
  const codeBlocks: string[] = [];
  let processed = text.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const escaped = escapeHtml(code.replace(/\n$/, ""));
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      const placeholder = `\x00CODEBLOCK${codeBlocks.length}\x00`;
      codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
      return placeholder;
    },
  );

  // Step 2: Extract inline code spans to protect them from further processing.
  const inlineCode: string[] = [];
  processed = processed.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const placeholder = `\x00INLINECODE${inlineCode.length}\x00`;
    inlineCode.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // Step 3: Escape HTML in remaining plain text (before applying formatting).
  // Escape HTML in plain text segments (skip placeholders marked with \x00)
  // oxlint-disable-next-line no-control-regex
  processed = processed.replace(/[^`\x00]+/g, (segment) => escapeHtml(segment));

  // Step 4: Apply inline formatting.
  // Bold: **text**
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  // Italic: *text* (not preceded by another *)
  processed = processed.replace(
    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    "<i>$1</i>",
  );
  // Italic: _text_ (surrounded by non-word or start/end)
  processed = processed.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");
  // Links: [text](url) — only allow safe URL schemes; escape the URL to
  // prevent HTML attribute injection (e.g. href="url" onmouseover="x")
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    /^https?:\/\//i.test(url)
      ? `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
      : text,
  );
  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Step 5: Restore inline code spans.
  for (let i = 0; i < inlineCode.length; i++) {
    processed = processed.replace(`\x00INLINECODE${i}\x00`, inlineCode[i]);
  }

  // Step 6: Restore fenced code blocks.
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`\x00CODEBLOCK${i}\x00`, codeBlocks[i]);
  }

  return processed;
}
