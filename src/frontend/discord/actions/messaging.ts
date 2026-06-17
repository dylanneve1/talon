/**
 * Messaging actions — send/reply/edit/delete/pin/forward/copy/react,
 * inline-button messages, typing indicator, and scheduled messages.
 */

import { withRetry } from "../../../core/engine/gateway.js";
import { sendChunked } from "../handlers/index.js";
import { suppressMentions, DISCORD_MAX_TEXT } from "../formatting.js";
import { logError } from "../../../util/log.js";
import { tryAction, resolveChannel, buildButtonRows } from "./shared.js";
import type { DiscordActionHandlers } from "./types.js";

export const messagingHandlers: DiscordActionHandlers = {
  send_message: (body, chatId, { channel, gateway }) => {
    const text = String(body.text ?? "");
    const replyTo =
      typeof body.reply_to_message_id === "string"
        ? body.reply_to_message_id
        : typeof body.reply_to === "string"
          ? body.reply_to
          : undefined;
    gateway.incrementMessages(chatId);
    return tryAction("send_message", async () => {
      const ids = await withRetry(() => sendChunked(channel!, text, replyTo));
      return { ok: true, message_id: ids[0], message_ids: ids };
    });
  },

  reply_to: (body, chatId, { channel, gateway }) => {
    const messageId = String(body.message_id ?? "");
    gateway.incrementMessages(chatId);
    return tryAction("reply_to", async () => {
      const ids = await withRetry(() =>
        sendChunked(channel!, String(body.text ?? ""), messageId),
      );
      return { ok: true, message_id: ids[0], message_ids: ids };
    });
  },

  react: (body, chatId, { channel, gateway }) => {
    gateway.incrementMessages(chatId);
    const emoji = String(body.emoji ?? "👍");
    const messageId = String(body.message_id ?? "");
    return tryAction("react", async () => {
      const target = await channel!.messages.fetch(messageId);
      // Don't silently fall back to 👍 — agent needs to know its chosen
      // emoji was rejected (likely malformed custom emoji format).
      await target.react(emoji);
      return { ok: true };
    });
  },

  edit_message: (body, _chatId, { channel }) => {
    const text = String(body.text ?? "");
    if (text.length > DISCORD_MAX_TEXT) {
      return {
        ok: false,
        error: `Edit text too long (max ${DISCORD_MAX_TEXT})`,
      };
    }
    const messageId = String(body.message_id ?? "");
    return tryAction("edit_message", async () => {
      const target = await channel!.messages.fetch(messageId);
      const safe = suppressMentions(text).slice(0, DISCORD_MAX_TEXT);
      await target.edit({ content: safe, allowedMentions: { parse: [] } });
      return { ok: true };
    });
  },

  delete_message: (body, _chatId, { channel }) => {
    const messageId = String(body.message_id ?? "");
    return tryAction("delete_message", async () => {
      const target = await channel!.messages.fetch(messageId);
      await target.delete();
      return { ok: true };
    });
  },

  pin_message: (body, _chatId, { channel }) => {
    const messageId = String(body.message_id ?? "");
    return tryAction("pin_message", async () => {
      const target = await channel!.messages.fetch(messageId);
      await target.pin();
      return { ok: true };
    });
  },

  unpin_message: (body, _chatId, { channel }) => {
    const messageId = body.message_id ? String(body.message_id) : undefined;
    return tryAction("unpin_message", async () => {
      if (messageId) {
        const target = await channel!.messages.fetch(messageId);
        await target.unpin();
      } else {
        const pinned = await channel!.messages.fetchPinned();
        for (const m of pinned.values()) await m.unpin();
      }
      return { ok: true };
    });
  },

  forward_message: forwardOrCopy,
  copy_message: forwardOrCopy,

  send_chat_action: async (_body, _chatId, { channel }) => {
    // typing only — Discord typing indicator
    try {
      await (channel as { sendTyping?: () => Promise<void> }).sendTyping?.();
    } catch {
      /* ignore */
    }
    return { ok: true };
  },

  send_message_with_buttons: (body, chatId, { channel, gateway }) => {
    const text = String(body.text ?? "");
    const rows = body.rows as Array<
      Array<{
        text: string;
        url?: string;
        callback_data?: string;
        style?: string;
      }>
    >;
    gateway.incrementMessages(chatId);
    const components = buildButtonRows(rows);
    const safe = suppressMentions(text).slice(0, DISCORD_MAX_TEXT);
    if (!channel!.isSendable())
      return { ok: false, error: "Channel not sendable" };
    return tryAction("send_message_with_buttons", async () => {
      const sent = await withRetry(
        () =>
          channel!.send({
            content: safe,
            components,
            allowedMentions: { parse: [] },
          }) as Promise<{ id: string }>,
      );
      return { ok: true, message_id: sent.id };
    });
  },

  schedule_message: (body, chatId, { client, scheduledMessages }) => {
    const text = String(body.text ?? "");
    const delaySec = Math.max(
      1,
      Math.min(3600, Number(body.delay_seconds ?? 60)),
    );
    const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(async () => {
      try {
        const c = await resolveChannel(client, chatId);
        if (c) await sendChunked(c, text);
      } catch (err) {
        logError("discord", `Scheduled message failed (chat=${chatId})`, err);
      }
      scheduledMessages.delete(scheduleId);
    }, delaySec * 1000);
    scheduledMessages.set(scheduleId, timer);
    return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
  },

  cancel_scheduled: (body, _chatId, { scheduledMessages }) => {
    const id = String(body.schedule_id ?? "");
    const timer = scheduledMessages.get(id);
    if (timer) {
      clearTimeout(timer);
      scheduledMessages.delete(id);
      return { ok: true, cancelled: true };
    }
    return { ok: false, error: "Schedule not found" };
  },
};

// forward_message / copy_message share an implementation — Discord has no true
// forward, so we replicate the content.
function forwardOrCopy(
  body: Record<string, unknown>,
  chatId: number,
  ctx: Parameters<DiscordActionHandlers[string]>[2],
) {
  const { channel, gateway } = ctx;
  const action = String(body.action);
  const messageId = String(body.message_id ?? "");
  return tryAction(action, async () => {
    const target = await channel!.messages.fetch(messageId);
    gateway.incrementMessages(chatId);
    const content = target.content || "";
    const ids = await withRetry(() => sendChunked(channel!, content));
    return { ok: true, message_id: ids[0] };
  });
}
