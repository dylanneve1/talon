/**
 * Messaging actions: send, reply, edit, delete, pin, forward, schedule, broadcast, etc.
 */

import { Api } from "telegram";
import {
  sendUserbotMessage,
  sendUserbotTyping,
  editUserbotMessage,
  deleteUserbotMessage,
  pinUserbotMessage,
  unpinUserbotMessage,
  forwardUserbotMessage,
  sendUserbotFile,
  getClient,
} from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { Gateway } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

const TELEGRAM_MAX_TEXT = 4096;

// ── Scheduled message state ──────────────────────────────────────────────────

type ScheduledEntry = ReturnType<typeof setTimeout>;
const scheduledMessages = new Map<string, ScheduledEntry>();

export function registerMessagingActions(
  registry: ActionRegistry,
  gateway: Gateway,
  recordOurMessage: (chatId: string, msgId: number) => void,
) {
  registry.set("send_message", async (body, chatId, peer, chatIdStr) => {
    const text = String(body.text ?? "");
    const replyTo = typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : undefined;
    gateway.incrementMessages(chatId);
    const msgId = await withRetry(() => sendUserbotMessage(peer, text, replyTo));
    recordOurMessage(chatIdStr, msgId);
    return { ok: true, message_id: msgId };
  });

  registry.set("reply_to", async (body, chatId, peer, chatIdStr) => {
    const replyToId = Number(body.message_id);
    const text = String(body.text ?? "");
    gateway.incrementMessages(chatId);
    const msgId = await withRetry(() => sendUserbotMessage(peer, text, replyToId));
    recordOurMessage(chatIdStr, msgId);
    return { ok: true, message_id: msgId };
  });

  registry.set("react", async (body, _chatId, peer) => {
    const client = getClient();
    const emoji = body.emoji ? String(body.emoji) : null;
    const documentId = body.document_id ? String(body.document_id) : null;
    const msgId = Number(body.message_id);
    const big = body.big === true;

    if (documentId && client) {
      await withRetry(() => client!.invoke(new Api.messages.SendReaction({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: peer as any,
        msgId,
        big,
        reaction: [new Api.ReactionCustomEmoji({
          documentId: BigInt(documentId) as unknown as import("big-integer").BigInteger,
        })],
      })));
    } else {
      const { reactUserbotMessage } = await import("../client.js");
      await withRetry(() => reactUserbotMessage(peer, msgId, emoji ?? "\u{1F44D}"));
    }
    return { ok: true };
  });

  registry.set("clear_reactions", async (body, _chatId, peer) => {
    const { clearUserbotReactions } = await import("../client.js");
    const msgId = Number(body.message_id);
    await clearUserbotReactions(peer, msgId);
    return { ok: true };
  });

  registry.set("edit_message", async (body, _chatId, peer) => {
    const text = String(body.text ?? "");
    if (text.length > TELEGRAM_MAX_TEXT)
      return { ok: false, error: `Text too long (max ${TELEGRAM_MAX_TEXT})` };
    await withRetry(() => editUserbotMessage(peer, Number(body.message_id), text));
    return { ok: true };
  });

  registry.set("delete_message", async (body, _chatId, peer) => {
    await deleteUserbotMessage(peer, Number(body.message_id));
    return { ok: true };
  });

  registry.set("pin_message", async (body, _chatId, peer) => {
    await pinUserbotMessage(peer, Number(body.message_id));
    return { ok: true };
  });

  registry.set("unpin_message", async (body, _chatId, peer) => {
    await unpinUserbotMessage(
      peer,
      body.message_id ? Number(body.message_id) : undefined,
    );
    return { ok: true };
  });

  registry.set("forward_message", async (body, chatId, peer) => {
    if (body.to_chat_id && Number(body.to_chat_id) !== chatId)
      return { ok: false, error: "Cross-chat forwarding not allowed." };
    const sentId = await forwardUserbotMessage(peer, Number(body.message_id));
    return { ok: true, message_id: sentId };
  });

  registry.set("copy_message", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const srcMsgId = Number(body.message_id);
    const toChatRaw = body.to_chat ?? body.to_chat_id;
    if (toChatRaw) {
      const toPeer: number | string = /^-?\d+$/.test(String(toChatRaw)) ? Number(toChatRaw) : String(toChatRaw);
      await withRetry(() => client!.forwardMessages(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toPeer as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { messages: [srcMsgId], fromPeer: peer as any, noforwards: false, dropAuthor: true },
      ));
      return { ok: true, message_id: srcMsgId, to_chat: toChatRaw };
    }
    const sentId = await forwardUserbotMessage(peer, srcMsgId);
    return { ok: true, message_id: sentId };
  });

  registry.set("send_chat_action", async (_body, _chatId, peer) => {
    await sendUserbotTyping(peer);
    return { ok: true };
  });

  registry.set("schedule_message", async (body, _chatId, peer, chatIdStr) => {
    const text = String(body.text ?? "");
    const delaySec = Math.max(1, Math.min(3600, Number(body.delay_seconds ?? 60)));
    const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(async () => {
      try {
        const msgId = await sendUserbotMessage(peer, text);
        recordOurMessage(chatIdStr, msgId);
      } catch { /* scheduled send failed */ }
      scheduledMessages.delete(scheduleId);
    }, delaySec * 1000);
    scheduledMessages.set(scheduleId, timer);
    return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
  });

  registry.set("cancel_scheduled", async (body) => {
    const timer = scheduledMessages.get(String(body.schedule_id ?? ""));
    if (timer) {
      clearTimeout(timer);
      scheduledMessages.delete(String(body.schedule_id));
      return { ok: true, cancelled: true };
    }
    return { ok: false, error: "Schedule not found" };
  });

  registry.set("send_message_with_buttons", async (body, chatId, peer, chatIdStr) => {
    const text = String(body.text ?? "");
    if (text.length > TELEGRAM_MAX_TEXT)
      return { ok: false, error: "Text too long" };
    gateway.incrementMessages(chatId);
    const msgId = await withRetry(() => sendUserbotMessage(peer, text));
    recordOurMessage(chatIdStr, msgId);
    return { ok: true, message_id: msgId, warning: "Inline keyboard buttons are not supported in user mode \u2014 message sent without buttons." };
  });

  registry.set("send_dice", async () => {
    return { ok: false, error: "send_dice is only available to bots, not user accounts." };
  });

  registry.set("send_to_chat", async (body) => {
    const to = String(body.to ?? "").trim();
    if (!to) return { ok: false, error: "to is required (username, phone, or chat ID)" };
    const targetPeer: number | string = /^-?\d+$/.test(to) ? Number(to) : to;
    const contentType = String(body.type ?? "text");
    const text = String(body.text ?? "");
    const filePath = body.file_path ? String(body.file_path) : undefined;
    const caption = body.caption ? String(body.caption) : undefined;

    if (contentType === "text" || !filePath) {
      if (!text) return { ok: false, error: "text is required for type=text" };
      const msgId = await withRetry(() => sendUserbotMessage(targetPeer, text));
      return { ok: true, message_id: msgId, to };
    }
    const msgId = await withRetry(() =>
      sendUserbotFile(targetPeer, { filePath, caption }),
    );
    return { ok: true, message_id: msgId, to };
  });

  registry.set("send_to_topic", async (body, chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const text = String(body.text ?? "");
    if (!text) return { ok: false, error: "text is required" };
    const topicId = Number(body.topic_id ?? 0);
    if (!topicId) return { ok: false, error: "topic_id is required" };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    gateway.incrementMessages(p);
    const sentMsgId = await withRetry(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client!.sendMessage(p as any, { message: text, replyTo: topicId }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgId = typeof sentMsgId === "object" ? (sentMsgId as any).id : sentMsgId;
    if (msgId) recordOurMessage(String(p), Number(msgId));
    return { ok: true, message_id: msgId, topic_id: topicId };
  });

  registry.set("send_scheduled", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const text = String(body.text ?? "");
    if (!text) return { ok: false, error: "text is required" };
    const sendAt = body.send_at;
    if (!sendAt) return { ok: false, error: "send_at is required (ISO date string or unix timestamp)" };
    const schedPeer = body.chat_id ? Number(body.chat_id) : peer;
    let scheduleDate: number;
    if (typeof sendAt === "number") {
      scheduleDate = sendAt;
    } else {
      const parsed = Date.parse(String(sendAt));
      if (isNaN(parsed)) return { ok: false, error: "Invalid send_at value" };
      scheduleDate = Math.floor(parsed / 1000);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schedMsg = await withRetry(() => client!.sendMessage(schedPeer as any, {
      message: text,
      schedule: scheduleDate,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schedMsgId = (schedMsg as any)?.id;
    return { ok: true, message_id: schedMsgId, scheduled_for: scheduleDate };
  });

  registry.set("forward_to", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const to = String(body.to ?? "").trim();
    if (!to) return { ok: false, error: "to is required (@username, numeric ID, etc.)" };
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    const targetPeer: number | string = /^-?\d+$/.test(to) ? Number(to) : to;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.forwardMessages(targetPeer as any, { messages: [msgId], fromPeer: peer as any }));
    return { ok: true, to };
  });

  registry.set("forward_messages_bulk", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const to = String(body.to ?? "").trim();
    if (!to) return { ok: false, error: "to is required (@username, numeric ID, etc.)" };
    const rawIds = body.message_ids;
    if (!Array.isArray(rawIds) || rawIds.length === 0)
      return { ok: false, error: "message_ids array is required" };
    const msgIds = (rawIds as unknown[]).map(Number).filter(Boolean);
    const fromPeer = body.from_chat_id ? Number(body.from_chat_id) : peer;
    const targetPeer: number | string = /^-?\d+$/.test(to) ? Number(to) : to;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.forwardMessages(targetPeer as any, {
      messages: msgIds,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fromPeer: fromPeer as any,
    }));
    return { ok: true, forwarded: msgIds.length, to };
  });

  registry.set("broadcast", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const text = String(body.text ?? "");
    if (!text) return { ok: false, error: "text is required" };
    const targets = Array.isArray(body.targets) ? (body.targets as unknown[]) : [];
    if (!targets.length) return { ok: false, error: "targets array is required (list of chat IDs or usernames)" };
    const results: Array<{ target: unknown; ok: boolean; error?: string }> = [];
    for (const target of targets) {
      try {
        const resolvedTarget = await client.getEntity(
          typeof target === "number" || typeof target === "string" ? target : String(target)
        ).catch(() => target);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await withRetry(() => client!.sendMessage(resolvedTarget as any, { message: text }));
        results.push({ target, ok: true });
        await new Promise((r) => setTimeout(r, 700));
      } catch (err) {
        results.push({ target, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const sent = results.filter((r) => r.ok).length;
    return { ok: true, sent, failed: results.length - sent, results };
  });

  registry.set("unpin_all_messages", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.messages.UnpinAllMessages({ peer: p as any })));
    return { ok: true };
  });

  registry.set("delete_messages_bulk", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const ids = Array.isArray(body.message_ids)
      ? (body.message_ids as unknown[]).map(Number).filter(Boolean)
      : [];
    if (!ids.length) return { ok: false, error: "message_ids array is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.deleteMessages(peer as any, ids, { revoke: body.revoke !== false }));
    return { ok: true, deleted: ids.length };
  });

  registry.set("delete_messages_by_date", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const fromDate = body.from_date ? Math.floor(new Date(String(body.from_date)).getTime() / 1000) : 0;
    const toDate = body.to_date ? Math.floor(new Date(String(body.to_date)).getTime() / 1000) : Math.floor(Date.now() / 1000);
    if (!fromDate) return { ok: false, error: "from_date (ISO string) is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.Search({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      q: "",
      filter: new Api.InputMessagesFilterEmpty(),
      minDate: fromDate,
      maxDate: toDate,
      offsetId: 0, addOffset: 0,
      limit: Math.min(Number(body.limit ?? 100), 100),
      maxId: 0, minId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgIds = (result.messages ?? []).map((m: any) => m.id as number);
    if (!msgIds.length) return { ok: true, deleted: 0, note: "No messages found in that date range" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.deleteMessages(p as any, msgIds, { revoke: body.revoke !== false }));
    return { ok: true, deleted: msgIds.length };
  });

  registry.set("clear_chat_history", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const revoke = body.revoke === true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.DeleteHistory({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      maxId: 0,
      revoke,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    return { ok: true, revoke, pts: result?.pts ?? 0 };
  });

  registry.set("save_to_saved", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const msgId = Number(body.message_id);
    const fromPeer = body.chat_id ? Number(body.chat_id) : peer;
    if (msgId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await withRetry(() => client!.forwardMessages(new Api.InputPeerSelf() as any, { messages: [msgId], fromPeer: fromPeer as any }));
    } else {
      const text = String(body.text ?? "");
      if (!text) return { ok: false, error: "Provide message_id or text" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await withRetry(() => sendUserbotMessage(new Api.InputPeerSelf() as any, text));
    }
    return { ok: true };
  });
}
