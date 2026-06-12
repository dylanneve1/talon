/**
 * Discord message formatting and splitting utilities.
 *
 * Discord supports markdown natively (no HTML conversion like Telegram). The job
 * here is to (a) chunk long messages so they fit Discord's 2000-char per-message
 * limit, splitting at safe boundaries, (b) keep code blocks intact, and (c)
 * provide an escape helper for embedding user-supplied text inside markdown.
 */

import { splitMessage as splitNative } from "../../native/textops.js";

export const DISCORD_MAX_TEXT = 2000;
/**
 * Headroom under DISCORD_MAX_TEXT for callers that interpolate user-supplied
 * text into a markdown wrapper (bold headers, code fences, etc.) where the
 * wrapper itself eats some of the 2000-char budget.
 */
export const DISCORD_SAFE_RESERVE = 100;

/**
 * Split a message into chunks ≤ max characters, preferring paragraph/newline/space
 * boundaries. Code fences are kept intact: if a split would land inside a fenced
 * block, the block is closed before the split and reopened in the next chunk.
 *
 * Delegates to the shared Zig core (native/textops-wasm), which fixes two bugs
 * in the JS loop this replaces: fence state was tracked by counting raw ```
 * occurrences (inline runs flipped it), and appending the close marker could
 * push a chunk past the 2000-char limit.
 */
export function splitMessage(text: string, max = DISCORD_MAX_TEXT): string[] {
  return splitNative(text, max);
}

/**
 * Escape user-supplied text so Discord doesn't interpret markdown / mentions.
 * Use ONLY when embedding untrusted text inside a message you're constructing.
 * Do not run on AI output (we want markdown to render).
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/([*_`~|>])/g, "\\$1")
    .replace(/^#/gm, "\\#")
    .replace(/^-/gm, "\\-");
}

/**
 * Suppress @everyone, @here, @&role, @userId mentions inside arbitrary text.
 * Wraps each "@" target with a zero-width space so Discord won't ping anyone.
 * Returned text is still readable.
 */
export function suppressMentions(text: string): string {
  return text
    .replace(/@everyone/g, "@​everyone")
    .replace(/@here/g, "@​here")
    .replace(/<@!?\d+>/g, (m) => m.replace("@", "@​"))
    .replace(/<@&\d+>/g, (m) => m.replace("@", "@​"));
}

/**
 * Slice a string to `max` user-visible characters without splitting multi-byte
 * code points (emoji, CJK) on a UTF-16 surrogate boundary. Used for Discord
 * `customId`, `label`, `value`, etc. where Discord measures char count.
 */
export function safeSlice(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/** Simple HTML-style escape used when displaying raw text inside code blocks. */
export function escapeForCodeBlock(text: string): string {
  // The only sequence that breaks an inline code/code block is a backtick run
  // longer than the wrapper. We can't trivially solve all cases — replace ``` with
  // a zero-width-joiner-separated equivalent so the fence never collides.
  return text.replace(/```/g, "`​``");
}
