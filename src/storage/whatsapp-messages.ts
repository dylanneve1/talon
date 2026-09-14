/**
 * Persistent WhatsApp message keys.
 *
 * The WhatsApp frontend hands every message it sees a numeric Talon id
 * and needs the WhatsApp key (and, for forwards and media re-downloads,
 * the whole proto) back later. Its in-memory store is a bounded cache;
 * this table is the record, so a reply, reaction or download addressed
 * at a message from before the last restart still resolves.
 *
 * The proto travels as JSON — the frontend serialises and rehydrates it;
 * storage never imports Baileys.
 */

import * as repo from "./repositories/whatsapp-messages-repo.js";

export type { WhatsAppMessageRecord } from "./repositories/whatsapp-messages-repo.js";

/** How long a message's key (and retained proto) stays retrievable. */
const WHATSAPP_MESSAGE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** Persist a message; a (chat, msg_id) already stored is left as is. */
export function saveWhatsAppMessage(record: repo.WhatsAppMessageRecord): void {
  repo.insert(record);
}

export function getWhatsAppMessage(
  msgId: number,
): repo.WhatsAppMessageRecord | undefined {
  return repo.byMsgId(msgId);
}

export function getWhatsAppMessageByWaId(
  waId: string,
): repo.WhatsAppMessageRecord | undefined {
  return repo.byWaId(waId);
}

/** Highest Talon id ever persisted — the restart seed for the id counter. */
export function maxWhatsAppMsgId(): number | undefined {
  return repo.maxMsgId();
}

/** Drop rows past the retention window; returns the number removed. */
export function pruneWhatsAppMessages(now = Date.now()): number {
  return repo.deleteOlderThan(now - WHATSAPP_MESSAGE_RETENTION_MS);
}

/** Test seam: forget every persisted message. */
export function clearWhatsAppMessages(): void {
  repo.deleteAll();
}
