/**
 * Media actions — sending files/photos/videos/animations/voice/audio,
 * stickers, polls, locations, contacts, and dice.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { expandFsPath } from "../../../util/fs-path.js";
import { markdownToTelegramHtml } from "../formatting.js";
import { withRetry } from "../../../core/engine/gateway.js";
import { resolveStickerByEmoji } from "../sticker-library.js";
import { replyParams, sendOpts } from "./shared.js";
import type { TelegramActionHandlers } from "./types.js";

type MediaSource = {
  file_path?: unknown;
  url?: unknown;
  file_id?: unknown;
};

/**
 * Resolve one media input to what the Bot API accepts. Three sources, in
 * priority order: a public URL or a Telegram file_id (both passed as a plain
 * string — Telegram fetches/reuses server-side, no local bytes involved),
 * else a workspace file path uploaded as multipart.
 */
export function resolveMediaInput(
  src: MediaSource,
  label: string,
  InputFileClass: typeof import("grammy").InputFile,
): { file: string | import("grammy").InputFile } | { error: string } {
  const remote = src.url ?? src.file_id;
  if (remote) return { file: String(remote) };
  // Fail with guidance the model can act on, not a raw ENOENT: a
  // mistyped path is the most common media-send error, and naming
  // the alternatives (url / file_id) teaches the recovery path.
  if (!src.file_path)
    return {
      error: `${label}: provide file_path (workspace file), url (public), or file_id (seen in chat)`,
    };
  const filePath = expandFsPath(String(src.file_path));
  if (!existsSync(filePath))
    return {
      error: `File not found: ${filePath} — check the workspace path, or send by url/file_id instead`,
    };
  const stat = statSync(filePath);
  if (stat.size > 49 * 1024 * 1024)
    return { error: "File too large (max 49MB)" };
  const data = readFileSync(filePath);
  return { file: new InputFileClass(data, basename(filePath)) };
}

const sendMediaFile: TelegramActionHandlers[string] = async (
  body,
  chatId,
  { bot, InputFileClass, gateway },
) => {
  // Routed for send_file / send_photo / send_video / send_animation /
  // send_voice / send_audio — branch on the action name in the body.
  const action = String(body.action);
  const caption = body.caption
    ? markdownToTelegramHtml(String(body.caption))
    : undefined;
  const captionParseMode = caption ? ("HTML" as const) : undefined;
  gateway.incrementMessages(chatId);
  const resolved = resolveMediaInput(body, action, InputFileClass);
  if ("error" in resolved) return { ok: false, error: resolved.error };
  const file = resolved.file;
  const rp = replyParams(body);
  const opts = sendOpts(body, chatId);
  // Spoiler blur only exists for visual media; Telegram rejects it elsewhere.
  const spoiler = body.spoiler === true || undefined;
  let sent;
  switch (action) {
    case "send_file":
      sent = await withRetry(() =>
        bot.api.sendDocument(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          ...opts,
        }),
      );
      break;
    case "send_photo":
      sent = await withRetry(() =>
        bot.api.sendPhoto(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          has_spoiler: spoiler,
          ...opts,
        }),
      );
      break;
    case "send_video":
      sent = await withRetry(() =>
        bot.api.sendVideo(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          has_spoiler: spoiler,
          ...opts,
        }),
      );
      break;
    case "send_animation":
      sent = await withRetry(() =>
        bot.api.sendAnimation(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          has_spoiler: spoiler,
          ...opts,
        }),
      );
      break;
    case "send_audio":
      sent = await withRetry(() =>
        bot.api.sendAudio(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          title: body.title as string | undefined,
          performer: body.performer as string | undefined,
          ...opts,
        }),
      );
      break;
    default:
      sent = await withRetry(() =>
        bot.api.sendVoice(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
          ...opts,
        }),
      );
      break;
  }
  return { ok: true, message_id: sent.message_id };
};

export const mediaHandlers: TelegramActionHandlers = {
  send_file: sendMediaFile,
  send_photo: sendMediaFile,
  send_video: sendMediaFile,
  send_animation: sendMediaFile,
  send_voice: sendMediaFile,
  send_audio: sendMediaFile,

  send_media_group: async (body, chatId, { bot, InputFileClass, gateway }) => {
    const items = Array.isArray(body.media) ? body.media : [];
    if (items.length < 2 || items.length > 10)
      return {
        ok: false,
        error: `Albums need 2–10 media items (got ${items.length}).`,
      };
    const spoiler = body.spoiler === true || undefined;
    type AlbumItem = {
      type: "photo" | "video" | "document" | "audio";
      media: string | import("grammy").InputFile;
      caption?: string;
      parse_mode?: "HTML";
      has_spoiler?: boolean;
    };
    const media: AlbumItem[] = [];
    for (const [i, raw] of items.entries()) {
      const item = raw as MediaSource & { type?: unknown; caption?: unknown };
      // Telegram albums mix photos and videos; documents/audio group only
      // with their own kind. Pass the declared type through and let the API
      // reject invalid mixes with its own (clear) error.
      const type = String(item.type ?? "photo");
      if (!["photo", "video", "document", "audio"].includes(type))
        return {
          ok: false,
          error: `media[${i}]: type must be photo, video, document, or audio`,
        };
      const resolved = resolveMediaInput(item, `media[${i}]`, InputFileClass);
      if ("error" in resolved) return { ok: false, error: resolved.error };
      const caption = item.caption
        ? markdownToTelegramHtml(String(item.caption))
        : undefined;
      media.push({
        type: type as AlbumItem["type"],
        media: resolved.file,
        caption,
        parse_mode: caption ? ("HTML" as const) : undefined,
        ...(type === "photo" || type === "video"
          ? { has_spoiler: spoiler }
          : {}),
      });
    }
    gateway.incrementMessages(chatId);
    // The wrapper types each album as homogeneous; runtime validation above
    // plus Telegram's own mixed-group errors cover what the cast waives.
    const group = media as unknown as Parameters<
      import("grammy").Bot["api"]["sendMediaGroup"]
    >[1];
    const sent = await withRetry(() =>
      bot.api.sendMediaGroup(chatId, group, {
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      }),
    );
    return { ok: true, message_ids: sent.map((m) => m.message_id) };
  },

  send_video_note: async (body, chatId, { bot, InputFileClass, gateway }) => {
    const resolved = resolveMediaInput(body, "send_video_note", InputFileClass);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    gateway.incrementMessages(chatId);
    // Round video bubbles take no caption; Telegram wants square video ≤60s.
    const sent = await withRetry(() =>
      bot.api.sendVideoNote(chatId, resolved.file, {
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      }),
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_venue: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendVenue(
      chatId,
      Number(body.latitude),
      Number(body.longitude),
      String(body.title ?? ""),
      String(body.address ?? ""),
      { reply_parameters: replyParams(body), ...sendOpts(body, chatId) },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_sticker: async (body, chatId, { bot, gateway }) => {
    // Three addressing modes: a concrete file_id, a public URL of a
    // .webp (Telegram fetches it server-side, like other media), or an
    // emoji resolved against the saved sticker library (optionally
    // pinned to one pack via set_name) — the low-friction path the
    // prompt teaches.
    let fileId = body.file_id
      ? String(body.file_id)
      : body.url
        ? String(body.url)
        : "";
    if (!fileId && body.emoji) {
      const resolved = await resolveStickerByEmoji(
        bot,
        String(body.emoji),
        body.set_name ? String(body.set_name) : undefined,
      );
      if (!resolved) {
        return {
          ok: false,
          error: `No saved sticker matches ${String(body.emoji)}${body.set_name ? ` in pack "${String(body.set_name)}"` : ""} — check the sticker library, or save a pack with save_sticker_pack.`,
        };
      }
      fileId = resolved.fileId;
    }
    if (!fileId)
      return { ok: false, error: "Required: file_id, url, or emoji" };
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendSticker(chatId, fileId, {
      reply_parameters: replyParams(body),
      ...sendOpts(body, chatId),
    });
    return { ok: true, message_id: sent.message_id };
  },

  send_poll: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendPoll(
      chatId,
      String(body.question ?? ""),
      ((body.options as string[]) ?? []).map((o) => ({ text: o })),
      {
        is_anonymous: body.is_anonymous as boolean | undefined,
        allows_multiple_answers: body.allows_multiple_answers as
          boolean | undefined,
        type: body.type as "regular" | "quiz" | undefined,
        correct_option_ids:
          body.correct_option_id != null
            ? [body.correct_option_id as number]
            : undefined,
        explanation: body.explanation as string | undefined,
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_location: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendLocation(
      chatId,
      Number(body.latitude),
      Number(body.longitude),
      { reply_parameters: replyParams(body), ...sendOpts(body, chatId) },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_contact: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendContact(
      chatId,
      String(body.phone_number),
      String(body.first_name),
      {
        last_name: body.last_name as string | undefined,
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_dice: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendDice(
      chatId,
      (body.emoji as string) || "🎲",
      {
        reply_parameters: replyParams(body),
        ...sendOpts(body, chatId),
      },
    );
    return {
      ok: true,
      message_id: sent.message_id,
      value: sent.dice?.value,
    };
  },
};
