/**
 * Shared helpers for Telegram action handlers: reply-parameter extraction and
 * the HTML-with-plain-fallback text sender.
 */

import type { Bot } from "grammy";
import { markdownToTelegramHtml, splitMessage } from "../formatting.js";
import { log, logWarn } from "../../../util/log.js";
import { TELEGRAM_MAX_TEXT } from "./types.js";

/**
 * Split target for over-long sends. Under the hard 4096 cap so the
 * HTML conversion (entity escaping, tags) has headroom — if a converted
 * chunk still overflows, the plain-text fallback in `sendOne` delivers
 * the raw chunk, which is guaranteed under the cap.
 */
const TELEGRAM_SPLIT_TARGET = TELEGRAM_MAX_TEXT - 200;

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

/**
 * Send text to a chat, auto-splitting anything over Telegram's 4096-char
 * limit into sequential messages (fence-aware — a ``` block is never
 * stranded open). Only the first chunk carries the reply threading; the
 * returned id is the first chunk's, the natural anchor for later
 * react/reply/pin. Overflow used to throw here, burning a model
 * round-trip on "Message too long" every time a reply ran hot.
 */
export async function sendText(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo?: number,
): Promise<number> {
  if (text.length <= TELEGRAM_MAX_TEXT) {
    return sendOne(bot, chatId, text, replyTo);
  }
  const chunks = splitMessage(text, TELEGRAM_SPLIT_TARGET);
  log(
    "bot",
    `sendText splitting ${text.length} chars into ${chunks.length} messages (chat=${chatId})`,
  );
  let firstId: number | undefined;
  for (const chunk of chunks) {
    const id = await sendOne(
      bot,
      chatId,
      chunk,
      firstId === undefined ? replyTo : undefined,
    );
    firstId ??= id;
  }
  // splitMessage never returns an empty array for the non-empty input that
  // got us past the length gate, so firstId is set.
  return firstId as number;
}

/** Send one ≤4096-char message: HTML first, plain-text fallback. */
async function sendOne(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo?: number,
): Promise<number> {
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
