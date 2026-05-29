/**
 * Discord-specific action handlers.
 *
 * Handles MCP tool actions that require the Discord API. Platform-agnostic
 * actions (cron, fetch_url, history) are handled by core/gateway-actions.ts
 * before this is called. The gateway maps a request to this handler by
 * numeric chatId; we resolve it back to a Discord channel via the registry
 * maintained in handlers.ts.
 *
 * Mapping notes vs Telegram:
 *  - send_message / reply_to / edit_message / delete_message: same intent.
 *  - react: emoji reactions are unicode in Discord; custom emoji uses <:name:id>.
 *  - send_message_with_buttons: rendered using ActionRow + ButtonBuilder.
 *  - send_photo/video/file/voice/audio: all become attachments (Discord doesn't
 *    distinguish "photo" vs "document" — file extension/contentType determines
 *    inline preview). We unify via AttachmentBuilder.
 *  - send_poll: Discord has Poll API (v10+); we use it.
 *  - schedule_message: in-memory timer, like Telegram.
 *  - get_chat_admins / get_chat_member_count: query guild members (best-effort —
 *    requires GuildMembers intent for full member lists).
 *  - Telegram-only actions (sticker pack mgmt, userbot history, set_chat_title)
 *    are not supported — return null so the gateway falls through (or {ok:false}
 *    where appropriate so the AI sees a clear error).
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { expandFsPath } from "../../util/fs-path.js";
import {
  type Client,
  type TextBasedChannel,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} from "discord.js";
import { withRetry } from "../../core/gateway.js";
import type { Gateway } from "../../core/gateway.js";
import type { ActionResult } from "../../core/types.js";
import { lookupDiscordChat, sendChunked } from "./handlers.js";
import { suppressMentions, safeSlice, DISCORD_MAX_TEXT } from "./formatting.js";
import { logWarn, logError } from "../../util/log.js";
import { mapDiscordError, maxAttachmentBytes } from "./errors.js";

/** Run a Discord action; convert DiscordAPIError into a clean ActionResult. */
async function tryAction(
  context: string,
  fn: () => Promise<ActionResult>,
): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapDiscordError(err, context);
    if (mapped) return mapped;
    return {
      ok: false,
      error: `${context} failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveChannel(
  client: Client,
  numericChatId: number,
): Promise<TextBasedChannel | null> {
  const info = lookupDiscordChat(numericChatId);
  if (!info) return null;
  try {
    const ch = await client.channels.fetch(info.channelId);
    if (ch && "send" in ch && (ch as TextBasedChannel).isSendable?.()) {
      return ch as TextBasedChannel;
    }
    if (info.userId) {
      const user = await client.users.fetch(info.userId);
      const dm = await user.createDM();
      return dm as TextBasedChannel;
    }
    return null;
  } catch (err) {
    logWarn(
      "discord",
      `resolveChannel failed for chat ${numericChatId}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

function buildButtonRows(
  rows: Array<
    Array<{
      text: string;
      url?: string;
      callback_data?: string;
      style?: string;
    }>
  >,
): ActionRowBuilder<ButtonBuilder>[] {
  const out: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const row of rows.slice(0, 5)) {
    const arb = new ActionRowBuilder<ButtonBuilder>();
    for (const btn of row.slice(0, 5)) {
      const b = new ButtonBuilder().setLabel(safeSlice(btn.text || "•", 80));
      if (btn.url) {
        b.setStyle(ButtonStyle.Link).setURL(btn.url);
      } else {
        const styleMap: Record<string, ButtonStyle> = {
          primary: ButtonStyle.Primary,
          secondary: ButtonStyle.Secondary,
          success: ButtonStyle.Success,
          danger: ButtonStyle.Danger,
        };
        const style =
          styleMap[btn.style ?? "secondary"] ?? ButtonStyle.Secondary;
        // Namespace AI-generated custom_ids under `ai:` so the callback router
        // never confuses them with system custom_ids like `settings:done`.
        // The router strips the prefix before forwarding to the agent.
        const raw = btn.callback_data || btn.text || "";
        const id = `ai:${safeSlice(raw, 96)}`;
        b.setStyle(style).setCustomId(id);
      }
      arb.addComponents(b);
    }
    out.push(arb);
  }
  return out;
}

// ── Factory ─────────────────────────────────────────────────────────────────

export function createDiscordActionHandler(client: Client, gateway: Gateway) {
  const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

  return async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;
    const channel = await resolveChannel(client, chatId);

    // For non-channel actions (e.g. cancel_scheduled, get_*) that don't need a
    // resolved channel right away, fall through. But most Discord actions need
    // it — return error if missing.
    const needsChannel = action !== "cancel_scheduled";
    if (needsChannel && !channel) {
      return {
        ok: false,
        error: `Discord channel not resolvable for chat ${chatId}`,
      };
    }

    switch (action) {
      // ── Messaging ─────────────────────────────────────────────────────
      case "send_message": {
        const text = String(body.text ?? "");
        const replyTo =
          typeof body.reply_to_message_id === "string"
            ? body.reply_to_message_id
            : typeof body.reply_to === "string"
              ? body.reply_to
              : undefined;
        gateway.incrementMessages(chatId);
        return tryAction("send_message", async () => {
          const ids = await withRetry(() =>
            sendChunked(channel!, text, replyTo),
          );
          return { ok: true, message_id: ids[0], message_ids: ids };
        });
      }

      case "reply_to": {
        const messageId = String(body.message_id ?? "");
        gateway.incrementMessages(chatId);
        return tryAction("reply_to", async () => {
          const ids = await withRetry(() =>
            sendChunked(channel!, String(body.text ?? ""), messageId),
          );
          return { ok: true, message_id: ids[0], message_ids: ids };
        });
      }

      case "react": {
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
      }

      case "edit_message": {
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
      }

      case "delete_message": {
        const messageId = String(body.message_id ?? "");
        return tryAction("delete_message", async () => {
          const target = await channel!.messages.fetch(messageId);
          await target.delete();
          return { ok: true };
        });
      }

      case "pin_message": {
        const messageId = String(body.message_id ?? "");
        return tryAction("pin_message", async () => {
          const target = await channel!.messages.fetch(messageId);
          await target.pin();
          return { ok: true };
        });
      }

      case "unpin_message": {
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
      }

      case "forward_message":
      case "copy_message": {
        const messageId = String(body.message_id ?? "");
        return tryAction(action, async () => {
          const target = await channel!.messages.fetch(messageId);
          // Discord doesn't have a true forward — replicate content.
          gateway.incrementMessages(chatId);
          const content = target.content || "";
          const ids = await withRetry(() => sendChunked(channel!, content));
          return { ok: true, message_id: ids[0] };
        });
      }

      case "send_chat_action": {
        // typing only — Discord typing indicator
        try {
          await (
            channel as { sendTyping?: () => Promise<void> }
          ).sendTyping?.();
        } catch {
          /* ignore */
        }
        return { ok: true };
      }

      case "send_message_with_buttons": {
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
      }

      case "schedule_message": {
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
            logError(
              "discord",
              `Scheduled message failed (chat=${chatId})`,
              err,
            );
          }
          scheduledMessages.delete(scheduleId);
        }, delaySec * 1000);
        scheduledMessages.set(scheduleId, timer);
        return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
      }

      case "cancel_scheduled": {
        const id = String(body.schedule_id ?? "");
        const timer = scheduledMessages.get(id);
        if (timer) {
          clearTimeout(timer);
          scheduledMessages.delete(id);
          return { ok: true, cancelled: true };
        }
        return { ok: false, error: "Schedule not found" };
      }

      // ── Media ──────────────────────────────────────────────────────────
      case "send_file":
      case "send_photo":
      case "send_video":
      case "send_animation":
      case "send_voice":
      case "send_audio": {
        const filePath = expandFsPath(String(body.file_path ?? ""));
        const caption = body.caption ? String(body.caption) : "";
        const stat = statSync(filePath);
        // Per-guild attachment cap based on boost tier. DMs use Tier-0 (10 MB).
        const guild = (channel as { guild?: import("discord.js").Guild })
          ?.guild;
        const maxBytes = maxAttachmentBytes(guild);
        if (stat.size > maxBytes) {
          const mb = (n: number) => Math.round(n / 1024 / 1024);
          const tierNote = guild
            ? `boost tier ${guild.premiumTier ?? 0}`
            : "DM";
          return {
            ok: false,
            error: `File too large (${mb(stat.size)}MB) — this ${tierNote} accepts max ${mb(maxBytes)}MB`,
          };
        }
        const data = readFileSync(filePath);
        const file = new AttachmentBuilder(data, { name: basename(filePath) });

        gateway.incrementMessages(chatId);
        if (!channel!.isSendable())
          return { ok: false, error: "Channel not sendable" };
        const replyTo =
          typeof body.reply_to === "string" ? body.reply_to : undefined;
        return tryAction(action, async () => {
          const sent = await withRetry(
            () =>
              channel!.send({
                content: caption
                  ? suppressMentions(caption).slice(0, DISCORD_MAX_TEXT)
                  : undefined,
                files: [file],
                allowedMentions: { parse: [] },
                reply: replyTo
                  ? { messageReference: replyTo, failIfNotExists: false }
                  : undefined,
              }) as Promise<{ id: string }>,
          );
          return { ok: true, message_id: sent.id };
        });
      }

      case "send_sticker": {
        const stickerId = String(body.file_id ?? body.sticker_id ?? "");
        if (!stickerId) return { ok: false, error: "Required: file_id" };
        if (!channel!.isSendable())
          return { ok: false, error: "Channel not sendable" };
        return tryAction("send_sticker", async () => {
          gateway.incrementMessages(chatId);
          const sent = (await channel!.send({ stickers: [stickerId] })) as {
            id: string;
          };
          return { ok: true, message_id: sent.id };
        });
      }

      case "send_poll": {
        const question = String(body.question ?? "");
        const options = ((body.options as string[]) ?? []).slice(0, 10);
        if (!question || options.length < 2)
          return { ok: false, error: "Poll requires question + ≥2 options" };
        gateway.incrementMessages(chatId);
        if (!channel!.isSendable())
          return { ok: false, error: "Channel not sendable" };
        return tryAction("send_poll", async () => {
          const sent = (await channel!.send({
            poll: {
              question: { text: question.slice(0, 300) },
              answers: options.map((o) => ({ text: o.slice(0, 55) })),
              allowMultiselect: Boolean(body.allows_multiple_answers),
              duration: 24,
            },
            allowedMentions: { parse: [] },
          })) as { id: string };
          return { ok: true, message_id: sent.id };
        });
      }

      case "send_location": {
        const lat = Number(body.latitude);
        const lng = Number(body.longitude);
        gateway.incrementMessages(chatId);
        const url = `https://maps.google.com/?q=${lat},${lng}`;
        return tryAction("send_location", async () => {
          const ids = await withRetry(() =>
            sendChunked(channel!, `📍 Location: ${lat}, ${lng}\n${url}`),
          );
          return { ok: true, message_id: ids[0] };
        });
      }

      case "send_contact": {
        const name = [body.first_name, body.last_name]
          .filter(Boolean)
          .map(String)
          .join(" ");
        const phone = String(body.phone_number ?? "");
        gateway.incrementMessages(chatId);
        return tryAction("send_contact", async () => {
          const ids = await withRetry(() =>
            sendChunked(channel!, `📇 Contact: ${name}\n${phone}`),
          );
          return { ok: true, message_id: ids[0] };
        });
      }

      case "send_dice": {
        const emoji = String(body.emoji ?? "🎲");
        const value = Math.floor(Math.random() * 6) + 1;
        gateway.incrementMessages(chatId);
        return tryAction("send_dice", async () => {
          const ids = await withRetry(() =>
            sendChunked(channel!, `${emoji} You rolled: **${value}**`),
          );
          return { ok: true, message_id: ids[0], value };
        });
      }

      // ── Chat info ──────────────────────────────────────────────────────
      case "get_chat_info": {
        const ch = channel!;
        if (ch.type === ChannelType.DM) {
          return {
            ok: true,
            id: ch.id,
            type: "dm",
            title: undefined,
            member_count: 2,
          };
        }
        const guildCh = ch as {
          guild?: { name: string; memberCount?: number };
        };
        return {
          ok: true,
          id: ch.id,
          type: "channel",
          title:
            (ch as { name?: string }).name ?? guildCh.guild?.name ?? "channel",
          member_count: guildCh.guild?.memberCount,
        };
      }

      case "get_chat_member_count": {
        const ch = channel!;
        if (ch.type === ChannelType.DM) return { ok: true, count: 2 };
        const guildCh = ch as { guild?: { memberCount?: number } };
        return { ok: true, count: guildCh.guild?.memberCount ?? 0 };
      }

      case "get_chat_member": {
        const userId = String(body.user_id ?? "");
        const ch = channel!;
        if (ch.type === ChannelType.DM)
          return { ok: false, error: "DM has no members beyond participants" };
        const guild = (ch as { guild?: import("discord.js").Guild }).guild;
        if (!guild) return { ok: false, error: "Channel has no guild context" };
        return tryAction("get_chat_member", async () => {
          const m =
            guild.members.cache.get(userId) ??
            (await guild.members.fetch(userId));
          const isOwner = m.id === guild.ownerId;
          return {
            ok: true,
            status: isOwner ? "owner" : "member",
            user: {
              id: m.user.id,
              first_name: m.displayName,
              username: m.user.username,
            },
          };
        });
      }

      case "get_chat_admins": {
        const ch = channel!;
        if (ch.type === ChannelType.DM)
          return { ok: false, error: "DM has no admins" };
        const guild = (ch as { guild?: import("discord.js").Guild }).guild;
        if (!guild) return { ok: false, error: "No guild context" };
        return tryAction("get_chat_admins", async () => {
          // Prefer the gateway-populated cache (auto-updated on
          // GUILD_MEMBER_ADD/UPDATE/REMOVE events when GuildMembers intent is
          // declared). Fall back to a one-shot fetch if empty (cold start
          // before chunks arrive).
          if (guild.members.cache.size === 0) await guild.members.fetch();
          const admins = [...guild.members.cache.values()].filter(
            (m) =>
              m.permissions.has("Administrator") ||
              m.permissions.has("ManageGuild"),
          );
          const text = admins
            .map((a) => `${a.displayName} (@${a.user.username}) id:${a.id}`)
            .join("\n");
          return { ok: true, text };
        });
      }

      case "set_chat_title": {
        const title = String(body.title ?? "");
        const ch = channel!;
        if (
          !("setName" in ch) ||
          typeof (ch as { setName: unknown }).setName !== "function"
        ) {
          return { ok: false, error: "Channel type does not support rename" };
        }
        return tryAction("set_chat_title", async () => {
          await (ch as { setName: (n: string) => Promise<unknown> }).setName(
            title,
          );
          return { ok: true };
        });
      }

      case "set_chat_description": {
        const description = String(body.description ?? "");
        const ch = channel!;
        if (
          !("setTopic" in ch) ||
          typeof (ch as { setTopic: unknown }).setTopic !== "function"
        ) {
          return {
            ok: false,
            error: "Channel type does not support description",
          };
        }
        return tryAction("set_chat_description", async () => {
          await (ch as { setTopic: (t: string) => Promise<unknown> }).setTopic(
            description,
          );
          return { ok: true };
        });
      }

      case "get_pinned_messages": {
        return tryAction("get_pinned_messages", async () => {
          const pinned = await channel!.messages.fetchPinned();
          const lines = [...pinned.values()].map((m) => {
            const author = m.author?.username ?? "user";
            return `[${author}] msg_id:${m.id}: ${m.content.slice(0, 200)}`;
          });
          return {
            ok: true,
            text: lines.length ? lines.join("\n") : "No pinned messages.",
          };
        });
      }

      // ── History (Discord-native fetch) ─────────────────────────────────
      case "read_history": {
        const limit = Math.min(100, Number(body.limit ?? 30));
        try {
          const messages = await channel!.messages.fetch({ limit });
          const sorted = [...messages.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp,
          );
          const lines = sorted.map((m) => {
            const who =
              m.author.id === client.user?.id
                ? "bot"
                : m.member?.displayName ||
                  m.author.globalName ||
                  m.author.username;
            const text =
              m.content || (m.attachments.size ? "(attachment)" : "");
            return `[${who}] msg_id:${m.id}: ${text.slice(0, 500)}`;
          });
          return { ok: true, text: lines.join("\n") };
        } catch (err) {
          // If Discord-level fetch fails (permission, channel gone), fall
          // through to shared in-memory history rather than surfacing the
          // error — caller has a generic fallback for this action.
          logWarn(
            "discord",
            `read_history fell through: ${err instanceof Error ? err.message : err}`,
          );
          return null;
        }
      }

      case "search_history": {
        const query = String(body.query ?? "").toLowerCase();
        const limit = Math.min(100, Number(body.limit ?? 20));
        try {
          const messages = await channel!.messages.fetch({ limit: 100 });
          const matches = [...messages.values()]
            .filter((m) => m.content.toLowerCase().includes(query))
            .slice(0, limit);
          const lines = matches.map((m) => {
            const who =
              m.member?.displayName || m.author.globalName || m.author.username;
            return `[${who}] msg_id:${m.id}: ${m.content.slice(0, 300)}`;
          });
          return {
            ok: true,
            text: lines.length ? lines.join("\n") : "No matches found.",
          };
        } catch (err) {
          logWarn(
            "discord",
            `search_history fell through: ${err instanceof Error ? err.message : err}`,
          );
          return null;
        }
      }

      case "list_known_users": {
        const ch = channel!;
        if (ch.type === ChannelType.DM)
          return { ok: true, text: "DM — only the participants are present." };
        const guild = (ch as { guild?: import("discord.js").Guild }).guild;
        if (!guild) return { ok: false, error: "No guild context" };
        return tryAction("list_known_users", async () => {
          const limit = Math.min(200, Number(body.limit ?? 50));
          if (guild.members.cache.size === 0) await guild.members.fetch();
          const lines = [...guild.members.cache.values()]
            .slice(0, limit)
            .map(
              (m) =>
                `${m.displayName} (@${m.user.username}) id:${m.id}${m.user.bot ? " [bot]" : ""}`,
            );
          return { ok: true, text: lines.join("\n") };
        });
      }

      case "get_member_info": {
        const userId = String(body.user_id ?? "");
        const ch = channel!;
        const guild = (ch as { guild?: import("discord.js").Guild }).guild;
        if (!guild) return { ok: false, error: "No guild context" };
        return tryAction("get_member_info", async () => {
          const m =
            guild.members.cache.get(userId) ??
            (await guild.members.fetch(userId));
          const roles = m.roles.cache.map((r) => r.name).join(", ");
          return {
            ok: true,
            text: [
              `Display: ${m.displayName}`,
              `Username: @${m.user.username}`,
              `ID: ${m.id}`,
              `Joined: ${m.joinedAt?.toISOString() ?? "?"}`,
              `Roles: ${roles || "none"}`,
              m.user.bot ? "Bot account" : "",
            ]
              .filter(Boolean)
              .join("\n"),
          };
        });
      }

      case "online_count": {
        const ch = channel!;
        if (ch.type === ChannelType.DM)
          return { ok: true, text: "DM has no online concept." };
        const guild = (
          ch as {
            guild?: { approximatePresenceCount?: number; memberCount?: number };
          }
        ).guild;
        if (!guild) return { ok: false, error: "No guild context" };
        return {
          ok: true,
          text: `Approx online: ${guild.approximatePresenceCount ?? "?"} / ${guild.memberCount ?? "?"}`,
        };
      }

      // Telegram-specific actions: not supported on Discord — return null so the
      // gateway falls through to plugins/shared, or {ok:false} to surface error.
      case "get_user_messages":
      case "get_message_by_id":
      case "save_sticker_pack":
      case "get_sticker_pack":
      case "download_sticker":
      case "create_sticker_set":
      case "add_sticker_to_set":
      case "delete_sticker_from_set":
      case "set_sticker_set_title":
      case "delete_sticker_set":
      case "stop_poll":
      case "download_media":
        return null;

      default:
        return null; // not a Discord action
    }
  };
}
