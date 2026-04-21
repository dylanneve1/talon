/**
 * Streaming preview for assistant responses.
 *
 * Owns a single Telegram preview (either a `sendMessageDraft` scratchpad or a
 * `sendMessage` + `editMessageText` in-place edit, auto-selected per stream
 * with per-instance fallback). Throttles partial updates, commits the preview
 * as a permanent message at text-block boundaries, and discards it when a tool
 * handled delivery instead.
 *
 * Modelled on openclaw's `createTelegramDraftStream`
 * (extensions/telegram/src/draft-stream.ts) but trimmed to the primitives this
 * bot actually uses — no lanes, no archived-preview cleanup.
 */

import type { Bot } from "grammy";
import { markdownToTelegramHtml } from "./formatting.js";
import { logWarn } from "../../util/log.js";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CHARS = 4096;
const THROTTLE_MS = 1000;
/** Wait this long before the first preview update — avoids flicker on fast responses. */
const INITIAL_DELAY_MS = 1000;
const DRAFT_ID_MAX = 2_147_483_647;

const DRAFT_UNAVAILABLE_RE =
  /(unknown method|method .*not (found|available|supported)|unsupported|can't be used|can be used only)/i;

// ── Monotonic draft-id allocator ────────────────────────────────────────────

let nextDraftId = 0;
function allocateDraftId(): number {
  nextDraftId = nextDraftId >= DRAFT_ID_MAX ? 1 : nextDraftId + 1;
  return nextDraftId;
}

// ── Types ────────────────────────────────────────────────────────────────────

type Transport = "draft" | "message";

type SendMessageDraftFn = (
  chatId: number,
  draftId: number,
  text: string,
  params?: { parse_mode?: "HTML" },
) => Promise<unknown>;

export type TelegramStream = {
  /** Feed the current accumulated assistant text. Throttled; may be a no-op. */
  update(rawMarkdown: string): void;
  /**
   * Commit this block as a permanent message and reset for the next block.
   * If `rawMarkdown` is omitted, commits whatever text is currently pending
   * from `update()`. Returns the delivered message_id, or undefined if
   * nothing was delivered.
   */
  commit(rawMarkdown?: string): Promise<number | undefined>;
  /** True if there is buffered text from `update()` that has not been committed. */
  hasPending(): boolean;
  /** Discard the current preview (tool delivered the answer). */
  discard(): Promise<void>;
};

// ── Transport resolution ────────────────────────────────────────────────────

function resolveSendMessageDraft(api: Bot["api"]): SendMessageDraftFn | undefined {
  const fn = (api as Bot["api"] & { sendMessageDraft?: SendMessageDraftFn })
    .sendMessageDraft;
  return typeof fn === "function" ? fn.bind(api as object) : undefined;
}

function shouldFallbackFromDraft(err: unknown): boolean {
  const text =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : typeof err === "object" && err && "description" in err
          ? String((err as { description?: unknown }).description ?? "")
          : "";
  return /sendMessageDraft/i.test(text) && DRAFT_UNAVAILABLE_RE.test(text);
}

// ── Factory ──────────────────────────────────────────────────────────────────

export type CreateTelegramStreamParams = {
  bot: Bot;
  chatId: number;
  replyToId: number;
};

export function createTelegramStream(
  params: CreateTelegramStreamParams,
): TelegramStream {
  const { bot, chatId, replyToId } = params;
  const api = bot.api;

  const draftApi = resolveSendMessageDraft(api);
  let transport: Transport = draftApi ? "draft" : "message";
  let draftId: number | undefined = transport === "draft" ? allocateDraftId() : undefined;

  // Preview state for the current generation.
  let messageId: number | undefined;
  let lastRenderedHtml = "";
  let pendingRaw = "";
  let initialDelayUntil = Date.now() + INITIAL_DELAY_MS;
  let lastSentAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<unknown> | undefined;
  let discarded = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const renderHtml = (raw: string): string => {
    const trimmed = raw.trimEnd();
    if (!trimmed) return "";
    try {
      return markdownToTelegramHtml(trimmed);
    } catch {
      return trimmed;
    }
  };

  const sendPreviewDraft = async (html: string): Promise<void> => {
    if (!draftApi || draftId === undefined) return;
    await draftApi(chatId, draftId, html, { parse_mode: "HTML" });
  };

  const sendOrEditMessage = async (html: string): Promise<void> => {
    if (messageId !== undefined) {
      await api.editMessageText(chatId, messageId, html, { parse_mode: "HTML" });
      return;
    }
    const sent = await api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      reply_parameters: replyToId ? { message_id: replyToId } : undefined,
    });
    messageId = sent.message_id;
  };

  const sendPreview = async (html: string): Promise<void> => {
    if (transport === "draft") {
      try {
        await sendPreviewDraft(html);
        return;
      } catch (err) {
        if (!shouldFallbackFromDraft(err)) throw err;
        logWarn(
          "bot",
          "sendMessageDraft unavailable for this chat — falling back to sendMessage/editMessageText",
        );
        transport = "message";
        draftId = undefined;
      }
    }
    await sendOrEditMessage(html);
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    if (discarded) return;
    const raw = pendingRaw;
    const html = renderHtml(raw);
    if (!html || html === lastRenderedHtml) return;
    if (html.length > MAX_CHARS) return; // commit path handles oversize by splitting

    const current = sendPreview(html).finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    try {
      await current;
      lastRenderedHtml = html;
      lastSentAt = Date.now();
    } catch (err) {
      logWarn(
        "bot",
        `stream preview update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const scheduleFlush = () => {
    if (timer || discarded) return;
    const now = Date.now();
    const gateUntil = Math.max(initialDelayUntil, lastSentAt + THROTTLE_MS);
    const delay = Math.max(0, gateUntil - now);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  };

  const update = (rawMarkdown: string) => {
    if (discarded) return;
    pendingRaw = rawMarkdown;
    if (inFlight) {
      scheduleFlush();
      return;
    }
    scheduleFlush();
  };

  /** Reset mutable state so the next commit/update starts a fresh message. */
  const resetForNextGeneration = () => {
    clearTimer();
    pendingRaw = "";
    lastRenderedHtml = "";
    messageId = undefined;
    initialDelayUntil = 0; // subsequent blocks don't need an initial delay
    lastSentAt = 0;
    if (transport === "draft" && draftApi) {
      draftId = allocateDraftId();
    }
  };

  const commit = async (rawMarkdown?: string): Promise<number | undefined> => {
    if (discarded) return undefined;
    clearTimer();
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* already logged */
      }
    }

    const source = rawMarkdown ?? pendingRaw;
    const html = renderHtml(source);
    if (!html) {
      // Nothing to commit; if a draft preview existed, clear it.
      if (transport === "draft" && draftApi && draftId !== undefined) {
        try {
          await draftApi(chatId, draftId, "");
        } catch {
          /* best-effort */
        }
      }
      resetForNextGeneration();
      return undefined;
    }

    try {
      if (transport === "message") {
        // Edit the streamed message in-place, or send a fresh one.
        if (html.length > MAX_CHARS) {
          // Final text won't fit a single message: finish the existing preview
          // (trimmed) and send the remainder as an additional message.
          const first = html.slice(0, MAX_CHARS);
          const rest = html.slice(MAX_CHARS);
          await sendOrEditMessage(first);
          const finalId = messageId;
          const sent = await api.sendMessage(chatId, rest.slice(0, MAX_CHARS), {
            parse_mode: "HTML",
          });
          resetForNextGeneration();
          return sent.message_id ?? finalId;
        }
        await sendOrEditMessage(html);
        const finalId = messageId;
        resetForNextGeneration();
        return finalId;
      }

      // Draft transport: materialize as a real message, then clear the draft.
      const materialized = await api.sendMessage(chatId, html.slice(0, MAX_CHARS), {
        parse_mode: "HTML",
        reply_parameters: replyToId ? { message_id: replyToId } : undefined,
      });
      if (draftApi && draftId !== undefined) {
        try {
          await draftApi(chatId, draftId, "");
        } catch {
          /* best-effort draft clear */
        }
      }
      resetForNextGeneration();
      return materialized.message_id;
    } catch (err) {
      logWarn(
        "bot",
        `stream commit failed, retrying as plain text: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Fall back to plain-text send, stripping HTML
      let plain = html;
      let prev: string;
      do {
        prev = plain;
        plain = plain.replace(/<[^>]*>/g, "");
      } while (plain !== prev);
      try {
        const sent = await api.sendMessage(chatId, plain.slice(0, MAX_CHARS), {
          reply_parameters: replyToId ? { message_id: replyToId } : undefined,
        });
        resetForNextGeneration();
        return sent.message_id;
      } catch (err2) {
        logWarn(
          "bot",
          `stream commit plain-text fallback failed: ${err2 instanceof Error ? err2.message : String(err2)}`,
        );
        resetForNextGeneration();
        return undefined;
      }
    }
  };

  const discard = async (): Promise<void> => {
    if (discarded) return;
    discarded = true;
    clearTimer();
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* ignore */
      }
    }

    // Draft transport: clear the scratchpad with an empty draft update.
    if (transport === "draft" && draftApi && draftId !== undefined && lastRenderedHtml) {
      try {
        await draftApi(chatId, draftId, "");
      } catch {
        /* best-effort */
      }
    }

    // Message transport: delete the streamed preview if we sent one but never
    // committed — the tool-based response replaced it.
    if (transport === "message" && messageId !== undefined) {
      try {
        await api.deleteMessage(chatId, messageId);
      } catch {
        /* best-effort */
      }
    }
  };

  const hasPending = (): boolean => {
    return !discarded && pendingRaw.trimEnd().length > 0;
  };

  return { update, commit, hasPending, discard };
}

// ── Testing hooks ────────────────────────────────────────────────────────────

export const __testing = {
  resetDraftIdAllocator() {
    nextDraftId = 0;
  },
};
