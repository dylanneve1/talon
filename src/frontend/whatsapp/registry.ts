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
import { bareId } from "./identity.js";

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

/**
 * Talon chat id for a WhatsApp JID.
 *
 * `canonical` is the identity's preferred id (phone number when known),
 * so a DM keeps ONE chat id even when WhatsApp switches the conversation
 * between phone-number and LID addressing mid-thread.
 */
export function chatIdForJid(jid: string, canonical?: string): string {
  const bare = canonical ?? bareId(jidNormalizedUser(jid));
  return isJidGroup(jid) ? `wa_group_${bare}` : `wa_dm_${bare}`;
}

/**
 * Record (or refresh) a chat's identity, returning its info.
 *
 * The send target (`jid`) is always the address the message arrived on —
 * that is what WhatsApp routes — while the chat id comes from the stable
 * canonical identity. A chat already known under one addressing form has
 * its send target refreshed rather than being duplicated.
 */
export function registerWhatsAppChat(
  jid: string,
  title?: string,
  canonical?: string,
): WhatsAppChatInfo {
  const chatId = chatIdForJid(jid, canonical);
  const sendJid = isJidGroup(jid) ? jid : jidNormalizedUser(jid);
  const existing = byString.get(chatId);
  if (existing) {
    if (title) existing.title = title;
    existing.jid = sendJid;
    return existing;
  }
  const info: WhatsAppChatInfo = {
    chatId,
    numericChatId: deriveNumericChatId(chatId),
    jid: sendJid,
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
