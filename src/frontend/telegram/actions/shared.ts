/**
 * Shared helpers for Telegram action handlers: reply-parameter extraction and
 * native Rich Markdown delivery with legacy fallbacks.
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

/**
 * Rich Messages arrived in Bot API 10.2. A self-hosted Bot API server (or a
 * deployment pinned to an older release) rejects `sendRichMessage` outright,
 * and retrying it per message would cost a doomed round-trip plus a warning
 * line on every single send. Probe once and latch, mirroring the
 * `draftsSupported` capability probe in `handlers/delivery.ts`.
 */
let richMessagesSupported = true;

/** Telegram's shape for "this build doesn't have that method". */
const METHOD_UNAVAILABLE_RE =
  /method not found|not supported|unknown method|unsupported method/i;

/** True while native Rich Markdown delivery is still worth attempting. */
export function richMessagesAvailable(): boolean {
  return richMessagesSupported;
}

/**
 * Log a failed Rich Message call and latch the capability off when the failure
 * says the method itself is missing. Payload-level rejections (a markdown
 * string Telegram won't parse) stay one-off — the next message may be fine.
 */
export function noteRichMessageFailure(err: unknown, context: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (METHOD_UNAVAILABLE_RE.test(msg)) {
    richMessagesSupported = false;
    logWarn(
      "bot",
      `Rich Messages unavailable on this Bot API server — using legacy HTML from now on (${context}): ${msg}`,
    );
    return;
  }
  logWarn(
    "bot",
    `Rich Markdown failed; falling back to HTML (${context}): ${msg}`,
  );
}

/** Test seam: re-arm the capability probe between cases. */
export function resetRichMessageSupport(): void {
  richMessagesSupported = true;
}

export async function sendText(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo?: number,
  replyMarkup?: NonNullable<
    Parameters<Bot["api"]["sendRichMessage"]>[2]
  >["reply_markup"],
): Promise<number> {
  if (text.length > TELEGRAM_MAX_TEXT) {
    throw new Error(
      `Message too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT}).`,
    );
  }

  if (richMessagesSupported) {
    try {
      const sent = await bot.api.sendRichMessage(
        chatId,
        { markdown: text },
        {
          reply_parameters: replyTo ? { message_id: replyTo } : undefined,
          reply_markup: replyMarkup,
        },
      );
      return sent.message_id;
    } catch (err) {
      noteRichMessageFailure(err, `send chat=${chatId}`);
    }
  }

  const html = markdownToTelegramHtml(text);
  try {
    const sent = await bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
      reply_markup: replyMarkup,
    });
    return sent.message_id;
  } catch (err) {
    logWarn(
      "bot",
      `Legacy HTML send failed; retrying as plain text (chat=${chatId}): ${err instanceof Error ? err.message : err}`,
    );
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
      reply_markup: replyMarkup,
    });
    return sent.message_id;
  }
}
