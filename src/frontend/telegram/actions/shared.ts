/**
 * Shared helpers for Telegram action handlers: reply-parameter extraction and
 * the HTML-with-plain-fallback text sender.
 */

import type { Bot } from "grammy";
import { markdownToTelegramHtml } from "../formatting.js";
import { logWarn } from "../../../util/log.js";
import { TELEGRAM_MAX_TEXT } from "./types.js";

export function replyParams(
  body: Record<string, unknown>,
): { message_id: number } | undefined {
  const replyTo = toPositiveId(body.reply_to ?? body.reply_to_message_id);
  return replyTo !== undefined ? { message_id: replyTo } : undefined;
}

/**
 * Telegram/GramJS APIs expect numeric IDs. `snowflakeOrIdSchema` normalizes IDs
 * to digit-strings (so 17-19 digit Discord snowflakes survive validation), so a
 * Telegram message/reply/offset ID can arrive here as a string. Coerce it back
 * to a positive integer: Telegram IDs are well within 2^53, so this is lossless.
 * Returns undefined for missing / non-positive / non-integer values.
 */
export function toPositiveId(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function sendText(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo?: number,
): Promise<number> {
  if (text.length > TELEGRAM_MAX_TEXT) {
    throw new Error(
      `Message too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT}).`,
    );
  }
  const html = markdownToTelegramHtml(text);
  try {
    const sent = await bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
    return sent.message_id;
  } catch (err) {
    logWarn(
      "bot",
      `sendText with parse_mode=HTML failed; retrying without parse_mode (chat=${chatId}): ${err instanceof Error ? err.message : err}`,
    );
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
    return sent.message_id;
  }
}
