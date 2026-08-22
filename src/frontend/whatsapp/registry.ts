/**
 * Chat-registry accessors — map between Talon chat ids (string and
 * numeric) and the WhatsApp JID the socket needs to post back.
 *
 * Populated on first inbound message from a chat; consulted by the
 * action handler (send_message routes by Talon chat id) and by the
 * Frontend contract's numeric-keyed sendMessage/sendTyping (cron,
 * pulse, heartbeat outbound).
 */

import { isJidGroup, jidNormalizedUser } from "baileys";
import { deriveNumericChatId } from "../../util/chat-id.js";

export type WhatsAppChatInfo = {
  /** Talon chat id: wa_dm_<number> or wa_group_<id>. */
  chatId: string;
  /** Stable 32-bit hash of chatId (dispatcher/gateway key). */
  numericChatId: number;
  /** The JID the socket sends to: <number>@s.whatsapp.net or <id>@g.us. */
  jid: string;
  isGroup: boolean;
  title?: string;
};

const byNumeric = new Map<number, WhatsAppChatInfo>();
const byString = new Map<string, WhatsAppChatInfo>();

/** Talon chat id for a WhatsApp JID. */
export function chatIdForJid(jid: string): string {
  const normalized = jidNormalizedUser(jid);
  const bare = normalized.split("@")[0];
  return isJidGroup(jid) ? `wa_group_${bare}` : `wa_dm_${bare}`;
}

/** Record (or refresh) a chat's identity, returning its info. */
export function registerWhatsAppChat(
  jid: string,
  title?: string,
): WhatsAppChatInfo {
  const chatId = chatIdForJid(jid);
  const existing = byString.get(chatId);
  if (existing) {
    if (title) existing.title = title;
    return existing;
  }
  const info: WhatsAppChatInfo = {
    chatId,
    numericChatId: deriveNumericChatId(chatId),
    jid: isJidGroup(jid) ? jid : jidNormalizedUser(jid),
    isGroup: Boolean(isJidGroup(jid)),
    ...(title ? { title } : {}),
  };
  byNumeric.set(info.numericChatId, info);
  byString.set(info.chatId, info);
  return info;
}

export function lookupWhatsAppChat(
  numericChatId: number,
): WhatsAppChatInfo | undefined {
  return byNumeric.get(numericChatId);
}

export function lookupWhatsAppChatByString(
  chatId: string,
): WhatsAppChatInfo | undefined {
  return byString.get(chatId);
}

/** Test seam: forget every registered chat. */
export function resetWhatsAppRegistry(): void {
  byNumeric.clear();
  byString.clear();
}
