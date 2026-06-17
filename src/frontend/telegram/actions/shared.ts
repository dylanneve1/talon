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
  const replyTo = body.reply_to ?? body.reply_to_message_id;
  return typeof replyTo === "number" && replyTo > 0
    ? { message_id: replyTo }
    : undefined;
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
