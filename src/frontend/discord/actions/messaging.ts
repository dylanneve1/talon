/**
 * Messaging actions — send/reply/edit/delete/pin/forward/copy/react,
 * inline-button messages, typing indicator, and scheduled messages.
 */

import type { Client } from "discord.js";
import { withRetry } from "../../../core/engine/gateway.js";
import { sendChunked } from "../handlers/index.js";
import {
  suppressMentions,
  splitMessage,
  DISCORD_MAX_TEXT,
} from "../formatting.js";
import { log, logError } from "../../../util/log.js";
import {
  saveScheduled,
  deleteScheduled,
  listScheduled,
  listScheduledForChat,
  MAX_OVERDUE_MS,
  type ScheduledMessage,
} from "../../../storage/scheduled-store.js";
import { tryAction, resolveChannel, buildButtonRows } from "./shared.js";
import type { DiscordActionHandlers } from "./types.js";

// ── Scheduled sends (persistent) ─────────────────────────────────────────────

/** Longest schedulable delay: 24h. Timers re-arm from the store on boot. */
const MAX_DELAY_SEC = 24 * 60 * 60;

/**
 * Deliver one scheduled entry, replaying whatever it was scheduled with.
 *
 * The `send` tool documents that "buttons and reply threading survive the
 * delay — the schedule handler replays them at fire time". Discord's path
 * used to call `sendChunked(c, entry.text)` and drop both, so a scheduled
 * message with buttons arrived bare while the caller had been told ok:true.
 */
async function fireScheduled(
  channel: Awaited<ReturnType<typeof resolveChannel>>,
  entry: ScheduledMessage,
): Promise<void> {
  if (!channel) return;
  const replyTo =
    entry.replyTo !== undefined ? String(entry.replyTo) : undefined;
  if (!entry.rows || entry.rows.length === 0) {
    await sendChunked(channel, entry.text, replyTo);
    return;
  }
  const components = buildButtonRows(entry.rows);
  const chunks = splitMessage(suppressMentions(entry.text), DISCORD_MAX_TEXT);
  for (let i = 0; i < chunks.length; i++) {
    if (!channel.isSendable()) return;
    const last = i === chunks.length - 1;
    await channel.send({
      content: chunks[i],
      ...(last ? { components } : {}),
      allowedMentions: { parse: [] },
      ...(i === 0 && replyTo
        ? { reply: { messageReference: replyTo, failIfNotExists: false } }
        : {}),
    });
  }
}

/** Arm a timer for a stored entry; fires, then cleans up store + map. */
function armScheduled(
  client: Client,
  entry: ScheduledMessage,
  timers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const delayMs = Math.max(0, entry.fireAt - Date.now());
  const timer = setTimeout(async () => {
    try {
      const c = await resolveChannel(client, Number(entry.chatId));
      if (c) await fireScheduled(c, entry);
    } catch (err) {
      logError(
        "discord",
        `Scheduled message failed (chat=${entry.chatId})`,
        err,
      );
    }
    deleteScheduled(entry.id);
    timers.delete(entry.id);
  }, delayMs);
  timers.set(entry.id, timer);
}

/**
 * Re-arm persisted scheduled sends after a restart. Overdue entries
 * fire immediately — late beats never — unless stale past
 * MAX_OVERDUE_MS, which drops them.
 */
export function restoreScheduledMessages(
  client: Client,
  timers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const entries = listScheduled("discord");
  if (entries.length === 0) return;
  let restored = 0;
  let dropped = 0;
  for (const entry of entries) {
    if (Date.now() - entry.fireAt > MAX_OVERDUE_MS) {
      deleteScheduled(entry.id);
      dropped++;
      continue;
    }
    armScheduled(client, entry, timers);
    restored++;
  }
  log(
    "discord",
    `Restored ${restored} scheduled message(s) from store${dropped > 0 ? `, dropped ${dropped} stale` : ""}`,
  );
}

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
    if (!channel!.isSendable())
      return { ok: false, error: "Channel not sendable" };
    return tryAction("send_message_with_buttons", async () => {
      // buildButtonRows is inside tryAction on purpose: it can still reject a
      // row, and escaping here would bypass the action's error mapping and
      // lose the text as well as the buttons.
      const components = buildButtonRows(rows);
      // Chunk rather than slice. `.slice(0, 2000)` dropped everything past
      // the limit mid-word and still answered ok:true, so the model never
      // learned its reply had been cut — while the SAME text without buttons
      // went through sendChunked and arrived whole.
      const chunks = splitMessage(suppressMentions(text), DISCORD_MAX_TEXT);
      const ids: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        const sent = await withRetry(
          () =>
            channel!.send({
              content: chunks[i],
              // Buttons belong on the final chunk: they act on the whole
              // message, and Discord would render a set per chunk otherwise.
              ...(last ? { components } : {}),
              allowedMentions: { parse: [] },
            }) as Promise<{ id: string }>,
        );
        ids.push(sent.id);
      }
      return { ok: true, message_id: ids[0], message_ids: ids };
    });
  },

  schedule_message: (body, chatId, { client, scheduledMessages }) => {
    const text = String(body.text ?? "");
    const rows = body.rows as ScheduledMessage["rows"];
    const replyTo =
      typeof body.reply_to_message_id === "string"
        ? body.reply_to_message_id
        : undefined;
    // NaN (e.g. delay_seconds: "5m") must fall back to the default, not
    // propagate: setTimeout(fn, NaN) fires immediately.
    const requested = Number(body.delay_seconds ?? 60);
    const delaySec = Math.max(
      1,
      Math.min(MAX_DELAY_SEC, Number.isFinite(requested) ? requested : 60),
    );
    const entry: ScheduledMessage = {
      id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      frontend: "discord",
      chatId: String(chatId),
      text,
      fireAt: Date.now() + delaySec * 1000,
      createdAt: Date.now(),
      replyTo,
      rows,
    };
    // Persist before arming: if we crash between the two, the restore
    // path delivers it; the reverse order could lose it forever.
    saveScheduled(entry);
    armScheduled(client, entry, scheduledMessages);
    return { ok: true, schedule_id: entry.id, delay_seconds: delaySec };
  },

  cancel_scheduled: (body, _chatId, { scheduledMessages }) => {
    const id = String(body.schedule_id ?? "");
    const timer = scheduledMessages.get(id);
    if (timer) {
      clearTimeout(timer);
      scheduledMessages.delete(id);
    }
    // The store is the source of truth — an entry can exist without a
    // live timer (scheduled before a restart, not yet re-armed here).
    const existed = deleteScheduled(id) || Boolean(timer);
    return existed
      ? { ok: true, cancelled: true }
      : { ok: false, error: "Schedule not found" };
  },

  list_scheduled: (body, chatId) => {
    const pending = listScheduledForChat("discord", String(chatId)).map(
      (e) => ({
        schedule_id: e.id,
        fires_in_seconds: Math.max(
          0,
          Math.round((e.fireAt - Date.now()) / 1000),
        ),
        text: e.text.length > 200 ? `${e.text.slice(0, 200)}…` : e.text,
      }),
    );
    return { ok: true, scheduled: pending, count: pending.length };
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
