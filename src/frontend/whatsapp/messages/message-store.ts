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
 * `forward_message` and media re-downloads need the full message, not
 * only its key, so the proto is retained too. The in-memory map is a
 * bounded cache that evicts oldest-first; the record is the
 * `whatsapp_messages` table (storage/whatsapp-messages.ts), which a miss
 * falls through to — so an id from before the last restart, or from
 * thousands of messages back, still resolves.
 */

import { proto, type WAMessage, type WAMessageKey } from "baileys";
import {
  getWhatsAppMessage,
  getWhatsAppMessageByWaId,
  saveWhatsAppMessage,
  clearWhatsAppMessages,
  type WhatsAppMessageRecord,
} from "../../../storage/whatsapp-messages.js";

export type StoredMessage = {
  /** Talon-facing numeric id. */
  msgId: number;
  /** What WhatsApp needs to act on the message. */
  key: WAMessageKey;
  /** Talon chat id (wa_dm_… / wa_group_…). */
  chatId: string;
  /** Retained for forward_message and media re-downloads. */
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
 * Raise the id counter past what persistent storage already holds.
 *
 * The counter is in-memory and restarts at ID_BASE every boot, but the
 * ids it hands out are also the `msg_id`s written to the history and
 * whatsapp_messages tables, where `INSERT OR IGNORE` dedupes. Without
 * this seed, the first messages after a daemon restart re-issue ids the
 * previous run already used — the IGNORE then silently drops them, and
 * a reaction/reply addressed at an old id hits whatever new message
 * reused the number. Called at frontend start with max(msg_id) + 1.
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

function cache(stored: StoredMessage): void {
  byMsgId.set(stored.msgId, stored);
  if (stored.key.id) byWaId.set(stored.key.id, stored.msgId);
  evictOldest();
}

/**
 * Proto ↔ JSON. Byte fields (media keys, hashes) travel as base64:
 * `toJSON` on a WebMessageInfo instance emits them that way, and
 * `fromObject` decodes them back, so a rehydrated message downloads.
 * Normalising through `fromObject` first also covers a plain object
 * that was never a proto instance (a Uint8Array would otherwise
 * stringify as `{"0":…}`).
 */
function serializeMessage(message: WAMessage): string {
  return JSON.stringify(proto.WebMessageInfo.fromObject(message).toJSON());
}

/** Rebuild a stored message from its persisted row. */
function fromRecord(record: WhatsAppMessageRecord): StoredMessage {
  const key: WAMessageKey = {
    id: record.waId,
    remoteJid: record.remoteJid,
    fromMe: record.fromMe,
    ...(record.participant ? { participant: record.participant } : {}),
  };
  let message: WAMessage | undefined;
  if (record.messageJson) {
    try {
      message = proto.WebMessageInfo.fromObject(
        JSON.parse(record.messageJson),
      ) as WAMessage;
    } catch {
      message = undefined; // an undecodable proto loses only forwarding
    }
  }
  return {
    msgId: record.msgId,
    key,
    chatId: record.chatId,
    text: record.text,
    senderName: record.senderName,
    timestamp: record.timestamp,
    ...(message ? { message } : {}),
  };
}

function persist(stored: StoredMessage): void {
  if (!stored.key.id || !stored.key.remoteJid) return;
  saveWhatsAppMessage({
    chatId: stored.chatId,
    msgId: stored.msgId,
    waId: stored.key.id,
    remoteJid: stored.key.remoteJid,
    fromMe: stored.key.fromMe === true,
    participant: stored.key.participant ?? undefined,
    senderName: stored.senderName,
    text: stored.text,
    timestamp: stored.timestamp,
    messageJson: stored.message ? serializeMessage(stored.message) : undefined,
  });
}

/**
 * Record a message and return its Talon numeric id. Re-recording a
 * WhatsApp id already seen returns the original number, so the same
 * message never gets two identities (Baileys can re-deliver on reconnect,
 * and a restart in between must not change the answer).
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
    const existing = byWaId.get(waId) ?? getWhatsAppMessageByWaId(waId)?.msgId;
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
  cache(stored);
  persist(stored);
  return msgId;
}

/** Look up a stored message by its Talon numeric id. */
export function lookupMessage(msgId: number): StoredMessage | undefined {
  const cached = byMsgId.get(msgId);
  if (cached) return cached;
  const record = getWhatsAppMessage(msgId);
  if (!record) return undefined;
  const stored = fromRecord(record);
  cache(stored);
  return stored;
}

/** Look up by WhatsApp's own id (reply resolution on inbound). */
export function lookupByWaId(waId: string): StoredMessage | undefined {
  const msgId = byWaId.get(waId) ?? getWhatsAppMessageByWaId(waId)?.msgId;
  return msgId === undefined ? undefined : lookupMessage(msgId);
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
  const stored = lookupMessage(msgId);
  if (!stored) {
    return {
      error:
        `Unknown message_id ${msgId} — WhatsApp message ids are assigned ` +
        `when Talon sees the message; use read_chat_history to find one.`,
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
  clearWhatsAppMessages();
  nextId = ID_BASE;
}
