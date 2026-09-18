import type { Context } from "grammy";
import { splitMessage } from "../formatting.js";
import { TELEGRAM_MAX_TEXT } from "../actions/types.js";

/**
 * Reply with an HTML listing, split across messages when it outgrows
 * Telegram's 4096-char cap. The per-item listings (chats, cron, pulse)
 * scale with the daemon's chat count, and a single oversized
 * `ctx.reply` fails the whole command with 400 "message is too long".
 * Entries are `\n\n`-separated and each carries balanced tags, so the
 * paragraph-first splitter never cuts through markup.
 */
export async function replyHtmlChunked(
  ctx: Context,
  text: string,
): Promise<void> {
  for (const chunk of splitMessage(text, TELEGRAM_MAX_TEXT)) {
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
}
