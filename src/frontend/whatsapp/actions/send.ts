/**
 * Outbound WhatsApp sends: quoted-reply resolution, the serialized
 * time-bounded socket queue, and the content/text senders that remember
 * what went out so later tool calls and history can address it.
 */

import type { AnyMessageContent, WAMessage, WASocket } from "baileys";
import { log } from "../../../util/log.js";
import type { ActionResult } from "../../../core/types.js";
import { toWhatsAppChunks } from "../formatting.js";
import { lookupMessage, rememberMessage } from "../message-store.js";
import { pushMessage, type HistoryMessage } from "../../../storage/history.js";
import type { WhatsAppChatInfo } from "../registry.js";

/**
 * Resolve a `reply_to` message id into the quoted message Baileys wants.
 * An unknown id quotes nothing rather than failing the send — the reply
 * link is a nicety, the message itself is the point.
 */
export function resolveQuoted(
  body: Record<string, unknown>,
  chatId: string,
): WAMessage | undefined {
  const raw = body.reply_to ?? body.reply_to_message_id;
  if (raw === undefined || raw === null) return undefined;
  const msgId = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(msgId)) return undefined;
  const stored = lookupMessage(msgId);
  if (!stored || stored.chatId !== chatId) return undefined;
  return (
    stored.message ?? {
      key: stored.key,
      message: { conversation: stored.text },
    }
  );
}

/**
 * How the bot signs its own rows in persistent history. Set once at
 * frontend start from `config.botDisplayName`; the 0 sender id is the
 * cross-frontend "this is the assistant" convention (native/protocol.ts).
 */
let botName = "Talon";
export function setWhatsAppBotName(name: string): void {
  if (name.trim()) botName = name.trim();
}

/**
 * History labels for outbound media, in HistoryMessage's closed
 * vocabulary. Payloads with no file analogue (polls, locations, contact
 * cards) return a text marker instead via `outboundTextMarker`.
 */
function outboundMediaType(
  content: AnyMessageContent,
): NonNullable<HistoryMessage["mediaType"]> | undefined {
  if ("image" in content) return "photo";
  if ("video" in content) return content.gifPlayback ? "animation" : "video";
  if ("audio" in content) return "voice";
  if ("sticker" in content) return "sticker";
  if ("document" in content) return "document";
  return undefined;
}

/** A readable stand-in for captionless payloads history can't type. */
function outboundTextMarker(content: AnyMessageContent): string {
  if ("poll" in content) return `[poll: ${content.poll.name}]`;
  if ("location" in content) return "[location]";
  if ("contacts" in content) return "[contact card]";
  return "";
}

// ── Serialized, time-bounded sends ─────────────────────────────────────────
//
// Ported from OpenClaw's socket-timing adapter. Two failure modes this
// removes, both observed live:
//   - a send on a dying socket hanging a turn indefinitely ("timed out
//     waiting for message" with nothing delivered and no error surfaced),
//   - interleaved sends racing each other's Baileys internals.
// Every outbound WhatsApp operation goes through one FIFO per process
// with a hard timeout; on timeout the queue advances so later sends
// aren't wedged behind the dead one.

const SEND_TIMEOUT_MS = 60_000;
let sendTail: Promise<unknown> = Promise.resolve();

class WhatsAppSendTimeoutError extends Error {
  constructor(operation: string) {
    super(
      `WhatsApp ${operation} timed out after ${SEND_TIMEOUT_MS / 1000}s — ` +
        `delivery state unknown (the socket may be dead or reconnecting)`,
    );
    this.name = "WhatsAppSendTimeoutError";
  }
}

/**
 * Run one socket operation serialized behind every earlier one, bounded
 * by SEND_TIMEOUT_MS. The timeout rejects THIS caller but releases the
 * queue, so a wedged operation can't dam everything after it.
 */
export function boundedSend<T>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  const prev = sendTail.catch(() => {});
  const result = prev.then(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new WhatsAppSendTimeoutError(operation)),
          SEND_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  });
  sendTail = result.catch(() => {});
  return result;
}

/**
 * Send one content payload, remember the resulting message so later
 * tool calls can address it, and report its Talon numeric id.
 */
export async function sendContent(
  ctx: { sock: WASocket; gateway: { incrementMessages: (id: number) => void } },
  chat: WhatsAppChatInfo,
  content: AnyMessageContent,
  options: { quoted?: WAMessage } = {},
): Promise<ActionResult> {
  const sent = await boundedSend("sendMessage", () =>
    ctx.sock.sendMessage(chat.jid, content, options),
  );
  ctx.gateway.incrementMessages(chat.numericChatId);
  if (!sent?.key) return { ok: true };
  const text =
    "text" in content
      ? String(content.text ?? "")
      : "caption" in content && content.caption
        ? String(content.caption)
        : outboundTextMarker(content);
  const msgId = rememberMessage({
    key: sent.key,
    chatId: chat.chatId,
    message: sent,
    text,
    senderName: "bot",
  });
  // Persist the bot's side of the conversation. Without this the history
  // store held only inbound messages, so read_chat_history showed a
  // one-sided chat and search_chat_history could never find anything the
  // bot itself had said — exactly the messages a fresh session needs when
  // reconstructing context after a reset or restart.
  const mediaType = outboundMediaType(content);
  if (text || mediaType) {
    pushMessage(chat.chatId, {
      msgId,
      senderId: 0,
      senderName: botName,
      text,
      timestamp: Date.now(),
      ...(mediaType ? { mediaType } : {}),
    });
  }
  return { ok: true, message_id: msgId };
}

/**
 * Send text, split across bubbles when it exceeds WhatsApp's limit. The
 * reported message id is the FIRST chunk's: it is the one a reply or
 * reaction should attach to, and the one Talon's callers treat as "the"
 * message.
 */
export async function sendText(
  ctx: { sock: WASocket; gateway: { incrementMessages: (id: number) => void } },
  chat: WhatsAppChatInfo,
  text: string,
  quoted?: WAMessage,
): Promise<ActionResult> {
  const chunks = toWhatsAppChunks(text);
  let first: ActionResult | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const result = await sendContent(
      ctx,
      chat,
      { text: chunk },
      // Only the first chunk quotes — a quoted block on every bubble of a
      // long answer is noise.
      index === 0 && quoted ? { quoted } : {},
    );
    first ??= result;
  }
  log(
    "whatsapp",
    `Sent ${chunks.length} chunk(s) to ${chat.chatId} (${text.length} chars)`,
  );
  return first ?? { ok: true };
}
