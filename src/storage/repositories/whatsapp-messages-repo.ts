/**
 * WhatsApp message-key repository — executes the statements in
 * sql/whatsapp-messages.sql against the `whatsapp_messages` table; no
 * SQL text lives here. The public store (storage/whatsapp-messages.ts)
 * holds the domain API; this module owns statement execution and the
 * row↔domain mapping.
 */

import { getDatabase } from "../db.js";
import { whatsappMessagesSql } from "../sql/statements.generated.js";

/** One persisted WhatsApp message as the domain sees it. */
export type WhatsAppMessageRecord = {
  chatId: string;
  msgId: number;
  waId: string;
  remoteJid: string;
  fromMe: boolean;
  participant?: string;
  senderName: string;
  text: string;
  timestamp: number;
  /** The full WAMessage proto as JSON, when it was retained. */
  messageJson?: string;
};

type Row = {
  chat_id: string;
  msg_id: number;
  wa_id: string;
  remote_jid: string;
  from_me: number;
  participant: string | null;
  sender_name: string;
  text: string;
  timestamp: number;
  message_json: string | null;
};

function rowToRecord(row: Row): WhatsAppMessageRecord {
  return {
    chatId: row.chat_id,
    msgId: row.msg_id,
    waId: row.wa_id,
    remoteJid: row.remote_jid,
    fromMe: row.from_me === 1,
    participant: row.participant ?? undefined,
    senderName: row.sender_name,
    text: row.text,
    timestamp: row.timestamp,
    messageJson: row.message_json ?? undefined,
  };
}

export function insert(record: WhatsAppMessageRecord): void {
  getDatabase()
    .prepare(whatsappMessagesSql.insert)
    .run(
      record.chatId,
      record.msgId,
      record.waId,
      record.remoteJid,
      record.fromMe ? 1 : 0,
      record.participant ?? null,
      record.senderName,
      record.text,
      record.timestamp,
      record.messageJson ?? null,
    );
}

export function byMsgId(msgId: number): WhatsAppMessageRecord | undefined {
  const row = getDatabase().prepare(whatsappMessagesSql.byMsgId).get(msgId) as
    Row | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function byWaId(waId: string): WhatsAppMessageRecord | undefined {
  const row = getDatabase().prepare(whatsappMessagesSql.byWaId).get(waId) as
    Row | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function maxMsgId(): number | undefined {
  const row = getDatabase().prepare(whatsappMessagesSql.maxMsgId).get() as {
    max_id: number | null;
  };
  return row.max_id ?? undefined;
}

/** Delete rows older than `cutoff` (ms); returns the number removed. */
export function deleteOlderThan(cutoff: number): number {
  const result = getDatabase()
    .prepare(whatsappMessagesSql.deleteOlderThan)
    .run(cutoff) as { changes: number | bigint };
  return Number(result.changes);
}

export function deleteAll(): void {
  getDatabase().prepare(whatsappMessagesSql.deleteAll).run();
}
