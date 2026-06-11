/**
 * Telegram message formatting and splitting utilities.
 */

import type { Bot } from "grammy";
import { logWarn } from "../../util/log.js";

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
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type TelegramMessageResult = { message_id: number };
type RawTelegramApi = {
  sendRichMessage?: (
    payload: Record<string, unknown>,
  ) => Promise<TelegramMessageResult>;
  sendRichMessageDraft?: (payload: Record<string, unknown>) => Promise<true>;
};

let richMessagesSupported: boolean | null = null;
let richDraftsSupported: boolean | null = null;

function rawTelegramApi(bot: Bot): RawTelegramApi | null {
  const raw = (bot.api as unknown as { raw?: unknown }).raw;
  return raw && typeof raw === "object" ? (raw as RawTelegramApi) : null;
}

function richUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /method not found|not found|unsupported|unknown method/i.test(message);
}

export function resetRichMessageSupportForTests(): void {
  richMessagesSupported = null;
  richDraftsSupported = null;
}

export async function trySendRichMarkdown(
  bot: Bot,
  chatId: number,
  markdown: string,
  replyToId?: number,
): Promise<number | null> {
  if (richMessagesSupported === false) return null;
  const raw = rawTelegramApi(bot);
  if (typeof raw?.sendRichMessage !== "function") {
    richMessagesSupported = false;
    return null;
  }

  try {
    const sent = await raw.sendRichMessage({
      chat_id: chatId,
      rich_message: { markdown },
      reply_parameters: replyToId ? { message_id: replyToId } : undefined,
    });
    richMessagesSupported = true;
    return sent.message_id;
  } catch (err) {
    if (richUnsupported(err)) {
      richMessagesSupported = false;
      logWarn("bot", "sendRichMessage not supported — using HTML formatting");
    } else {
      logWarn(
        "bot",
        `sendRichMessage failed; using HTML formatting: ${err instanceof Error ? err.message : err}`,
      );
    }
    return null;
  }
}

export async function trySendRichMarkdownDraft(
  bot: Bot,
  chatId: number,
  draftId: number,
  markdown: string,
): Promise<boolean> {
  if (richDraftsSupported === false) return false;
  const raw = rawTelegramApi(bot);
  if (typeof raw?.sendRichMessageDraft !== "function") {
    richDraftsSupported = false;
    return false;
  }

  try {
    await raw.sendRichMessageDraft({
      chat_id: chatId,
      draft_id: draftId,
      rich_message: { markdown },
    });
    richDraftsSupported = true;
    return true;
  } catch (err) {
    if (richUnsupported(err)) {
      richDraftsSupported = false;
      logWarn("bot", "sendRichMessageDraft not supported — using text drafts");
    } else {
      logWarn(
        "bot",
        `sendRichMessageDraft failed; using text drafts: ${err instanceof Error ? err.message : err}`,
      );
    }
    return false;
  }
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
  // Links: [text](url) — only allow safe URL schemes.
  // NOTE: `url` is already HTML-escaped from step 3 (the global entity-escape
  // pass ran over the entire text including link targets). Re-applying
  // escapeHtml here would double-encode `&` as `&amp;amp;`, breaking any URL
  // that contains query-string parameters (e.g. `?a=1&b=2`).
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) =>
    /^https?:\/\//i.test(url) ? `<a href="${url}">${text}</a>` : text,
  );
  // Strikethrough: ~~text~~
  processed = processed.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Step 5: Restore inline code spans.
  // Use a function replacement to prevent JS from interpreting `$&`, `$1`,
  // etc. in the replacement string as special patterns — user code can
  // legitimately contain dollar-sign sequences that would otherwise expand
  // incorrectly (e.g. `$&` would be replaced by the matched placeholder text).
  for (let i = 0; i < inlineCode.length; i++) {
    const html = inlineCode[i];
    processed = processed.replace(`\x00INLINECODE${i}\x00`, () => html);
  }

  // Step 6: Restore fenced code blocks.
  for (let i = 0; i < codeBlocks.length; i++) {
    const html = codeBlocks[i];
    processed = processed.replace(`\x00CODEBLOCK${i}\x00`, () => html);
  }

  return processed;
}
