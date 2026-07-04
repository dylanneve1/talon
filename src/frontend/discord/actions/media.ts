/**
 * Media actions — file/photo/video/animation/voice/audio attachments,
 * stickers, polls, locations, contacts, dice.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { expandFsPath } from "../../../util/fs-path.js";
import { AttachmentBuilder } from "discord.js";
import { withRetry } from "../../../core/engine/gateway.js";
import { sendChunked } from "../handlers/index.js";
import { suppressMentions, DISCORD_MAX_TEXT } from "../formatting.js";
import { maxAttachmentBytes } from "../errors.js";
import { tryAction } from "./shared.js";
import type { DiscordActionHandlers } from "./types.js";

const sendAttachment: DiscordActionHandlers[string] = (
  body,
  chatId,
  { channel, gateway },
) => {
  const action = String(body.action);
  const caption = body.caption ? String(body.caption) : "";
  let file: string | AttachmentBuilder;
  if (body.url) {
    // Public URL — Discord fetches it when attaching; no local bytes.
    file = String(body.url);
  } else if (body.file_id && !body.file_path) {
    // The shared `send` tool advertises file_id for Telegram; Discord has
    // no equivalent. Fail with guidance instead of a stat("") ENOENT.
    return {
      ok: false,
      error:
        "Discord has no file_id concept — re-send media by its CDN url or a workspace file_path.",
    };
  } else {
    if (!body.file_path)
      return {
        ok: false,
        error: `${action}: provide file_path (workspace file) or url (public)`,
      };
    const filePath = expandFsPath(String(body.file_path));
    if (!existsSync(filePath))
      return {
        ok: false,
        error: `File not found: ${filePath} — check the workspace path, or send by url instead`,
      };
    const stat = statSync(filePath);
    // Per-guild attachment cap based on boost tier. DMs use Tier-0 (10 MB).
    const guild = (channel as { guild?: import("discord.js").Guild })?.guild;
    const maxBytes = maxAttachmentBytes(guild);
    if (stat.size > maxBytes) {
      const mb = (n: number) => Math.round(n / 1024 / 1024);
      const tierNote = guild ? `boost tier ${guild.premiumTier ?? 0}` : "DM";
      return {
        ok: false,
        error: `File too large (${mb(stat.size)}MB) — this ${tierNote} accepts max ${mb(maxBytes)}MB`,
      };
    }
    const data = readFileSync(filePath);
    file = new AttachmentBuilder(data, { name: basename(filePath) });
  }

  gateway.incrementMessages(chatId);
  if (!channel!.isSendable())
    return { ok: false, error: "Channel not sendable" };
  const replyTo = typeof body.reply_to === "string" ? body.reply_to : undefined;
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
};

export const mediaHandlers: DiscordActionHandlers = {
  send_file: sendAttachment,
  send_photo: sendAttachment,
  send_video: sendAttachment,
  send_animation: sendAttachment,
  send_voice: sendAttachment,
  send_audio: sendAttachment,

  send_sticker: (body, chatId, { channel, gateway }) => {
    const stickerId = String(body.file_id ?? body.sticker_id ?? "");
    if (!stickerId)
      return {
        ok: false,
        error:
          "Required: file_id (a Discord sticker id) — sending stickers by emoji from saved packs is Telegram-only.",
      };
    if (!channel!.isSendable())
      return { ok: false, error: "Channel not sendable" };
    const replyTo =
      typeof body.reply_to === "string" ? body.reply_to : undefined;
    return tryAction("send_sticker", async () => {
      gateway.incrementMessages(chatId);
      const sent = (await channel!.send({
        stickers: [stickerId],
        reply: replyTo
          ? { messageReference: replyTo, failIfNotExists: false }
          : undefined,
      })) as { id: string };
      return { ok: true, message_id: sent.id };
    });
  },

  send_poll: (body, chatId, { channel, gateway }) => {
    const question = String(body.question ?? "");
    const options = ((body.options as string[]) ?? []).slice(0, 10);
    if (!question || options.length < 2)
      return { ok: false, error: "Poll requires question + ≥2 options" };
    gateway.incrementMessages(chatId);
    if (!channel!.isSendable())
      return { ok: false, error: "Channel not sendable" };
    const replyTo =
      typeof body.reply_to === "string" ? body.reply_to : undefined;
    return tryAction("send_poll", async () => {
      const sent = (await channel!.send({
        poll: {
          question: { text: question.slice(0, 300) },
          answers: options.map((o) => ({ text: o.slice(0, 55) })),
          allowMultiselect: Boolean(body.allows_multiple_answers),
          duration: 24,
        },
        allowedMentions: { parse: [] },
        reply: replyTo
          ? { messageReference: replyTo, failIfNotExists: false }
          : undefined,
      })) as { id: string };
      return { ok: true, message_id: sent.id };
    });
  },

  send_location: (body, chatId, { channel, gateway }) => {
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    gateway.incrementMessages(chatId);
    const url = `https://maps.google.com/?q=${lat},${lng}`;
    const replyTo =
      typeof body.reply_to === "string" ? body.reply_to : undefined;
    return tryAction("send_location", async () => {
      const ids = await withRetry(() =>
        sendChunked(channel!, `📍 Location: ${lat}, ${lng}\n${url}`, replyTo),
      );
      return { ok: true, message_id: ids[0] };
    });
  },

  send_contact: (body, chatId, { channel, gateway }) => {
    const name = [body.first_name, body.last_name]
      .filter(Boolean)
      .map(String)
      .join(" ");
    const phone = String(body.phone_number ?? "");
    gateway.incrementMessages(chatId);
    const replyTo =
      typeof body.reply_to === "string" ? body.reply_to : undefined;
    return tryAction("send_contact", async () => {
      const ids = await withRetry(() =>
        sendChunked(channel!, `📇 Contact: ${name}\n${phone}`, replyTo),
      );
      return { ok: true, message_id: ids[0] };
    });
  },

  send_dice: (body, chatId, { channel, gateway }) => {
    const emoji = String(body.emoji ?? "🎲");
    const value = Math.floor(Math.random() * 6) + 1;
    gateway.incrementMessages(chatId);
    const replyTo =
      typeof body.reply_to === "string" ? body.reply_to : undefined;
    return tryAction("send_dice", async () => {
      const ids = await withRetry(() =>
        sendChunked(channel!, `${emoji} You rolled: **${value}**`, replyTo),
      );
      return { ok: true, message_id: ids[0], value };
    });
  },
};
