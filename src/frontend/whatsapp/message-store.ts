/**
 * Message-key store — the bridge between Talon's numeric message ids and
 * WhatsApp's opaque string ones.
 *
 * Every Talon messaging tool addresses a message by number (`react`,
 * `edit_message`, `delete_message`, `reply_to`, …), but WhatsApp ids look
 * like `3EB0C767D26B8F3A1B2C` and the operations that act on a message
 * need a whole `WAMessageKey` (id + remoteJid + fromMe + participant),
 * not just the id. So each message Talon sees — inbound or sent — is
 * assigned a monotonic numeric id here and remembered alongside its key.
 *
 * `forward_message` needs the full message, not only its key, so the
 * proto is retained too. The map is bounded and evicts oldest-first: a
 * long-running daemon must not accumulate every message it ever saw, and
 * a model addressing a message thousands of turns back is not a case
 * worth holding memory for.
 */

import type { WAMessage, WAMessageKey } from "baileys";

export type StoredMessage = {
  /** Talon-facing numeric id. */
  msgId: number;
  /** What WhatsApp needs to act on the message. */
  key: WAMessageKey;
  /** Talon chat id (wa_dm_… / wa_group_…). */
  chatId: string;
  /** Retained for forward_message, which re-sends the whole message. */
  message?: WAMessage;
  /** Plain text at the time it was stored (copy_message, previews). */
  text: string;
  senderName: string;
  timestamp: number;
};

/**
 * Ids start high so they can't be confused with a small ordinal the model
 * might invent, and stay well inside 2^53.
 */
const ID_BASE = 1_000_000;
const MAX_TRACKED = 2_000;

let nextId = ID_BASE;

/**
 * Raise the id counter past what persistent history already holds.
 *
 * The counter is in-memory and restarts at ID_BASE every boot, but the
 * ids it hands out are also the `msg_id`s written to the history table,
 * where `INSERT OR IGNORE` + UNIQUE(chat_id, msg_id) dedupes. Without
 * this seed, the first messages after a daemon restart re-issue ids the
 * previous run already used — the IGNORE then silently drops them from
 * history, and a reaction/reply addressed at an old id from history hits
 * whatever new message reused the number. Called at frontend start with
 * max(msg_id) over wa_* chats + 1.
 */
export function seedMessageStore(floor: number): void {
  if (Number.isFinite(floor)) nextId = Math.max(nextId, Math.floor(floor));
}
const byMsgId = new Map<number, StoredMessage>();
const byWaId = new Map<string, number>();

function evictOldest(): void {
  while (byMsgId.size > MAX_TRACKED) {
    // Map iteration is insertion-ordered, so the first key is the oldest.
    const oldest = byMsgId.keys().next();
    if (oldest.done) return;
    const stored = byMsgId.get(oldest.value);
    byMsgId.delete(oldest.value);
    if (stored?.key.id) byWaId.delete(stored.key.id);
  }
}

/**
 * Record a message and return its Talon numeric id. Re-recording a
 * WhatsApp id already seen returns the original number, so the same
 * message never gets two identities (Baileys can re-deliver on reconnect).
 */
export function rememberMessage(entry: {
  key: WAMessageKey;
  chatId: string;
  message?: WAMessage;
  text?: string;
  senderName?: string;
  timestamp?: number;
}): number {
  const waId = entry.key.id;
  if (waId) {
    const existing = byWaId.get(waId);
    if (existing !== undefined) return existing;
  }
  const msgId = nextId++;
  const stored: StoredMessage = {
    msgId,
    key: entry.key,
    chatId: entry.chatId,
    text: entry.text ?? "",
    senderName: entry.senderName ?? "",
    timestamp: entry.timestamp ?? Date.now(),
    ...(entry.message ? { message: entry.message } : {}),
  };
  byMsgId.set(msgId, stored);
  if (waId) byWaId.set(waId, msgId);
  evictOldest();
  return msgId;
}

/** Look up a stored message by its Talon numeric id. */
export function lookupMessage(msgId: number): StoredMessage | undefined {
  return byMsgId.get(msgId);
}

/** Look up by WhatsApp's own id (reply resolution on inbound). */
export function lookupByWaId(waId: string): StoredMessage | undefined {
  const msgId = byWaId.get(waId);
  return msgId === undefined ? undefined : byMsgId.get(msgId);
}

/**
 * Resolve a tool-supplied message id (number or digit string) to the
 * WhatsApp key it names, scoped to one chat so a stale id from another
 * conversation can't act on this one.
 */
export function resolveKey(
  value: unknown,
  chatId: string,
): { key: WAMessageKey; stored: StoredMessage } | { error: string } {
  const msgId =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(msgId)) {
    return { error: `Invalid message_id: ${String(value)}` };
  }
  const stored = byMsgId.get(msgId);
  if (!stored) {
    return {
      error:
        `Unknown message_id ${msgId} — WhatsApp message ids are assigned ` +
        `when Talon sees the message; only recent ones can be acted on.`,
    };
  }
  if (stored.chatId !== chatId) {
    return { error: `Message ${msgId} belongs to a different chat` };
  }
  return { key: stored.key, stored };
}

/** Test seam: drop every tracked message and restart the id counter. */
export function resetMessageStore(): void {
  byMsgId.clear();
  byWaId.clear();
  nextId = ID_BASE;
}
