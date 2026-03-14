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
 * Detect if text contains Markdown that Telegram can render.
 * Conservative — only returns true when there's clear formatting.
 */
export function containsTelegramMarkdown(text: string): boolean {
  // Bold, italic, code, links
  return /\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)/.test(text);
}

/**
 * Escape characters that break Telegram Markdown parsing when the
 * text isn't intended to be Markdown.
 */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
