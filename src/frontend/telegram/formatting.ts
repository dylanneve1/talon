/**
 * Telegram message formatting and splitting utilities.
 */

/** Split a message into chunks that fit Telegram's 4096 char limit. */
export function splitMessage(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    // Prefer splitting at paragraph breaks, then newlines, then spaces
    let at = rest.lastIndexOf("\n\n", max);
    if (at <= max * 0.3) at = rest.lastIndexOf("\n", max);
    if (at <= max * 0.3) at = rest.lastIndexOf(" ", max);
    if (at <= 0) at = max;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  return chunks;
}

/**
 * Escape HTML special characters for Telegram HTML parse mode.
 * Must be applied to all text that is NOT inside an HTML tag.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert Claude's Markdown output to Telegram-safe HTML.
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
  // We need to avoid escaping our placeholders.
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
  // Links: [text](url)
  processed = processed.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>',
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

/**
 * Map common SDK/API error messages to user-friendly strings.
 * Delegates to core/errors.ts for classification.
 */
export { friendlyMessage as friendlyError } from "../../core/errors.js";
