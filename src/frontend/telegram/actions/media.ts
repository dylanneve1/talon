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
import { replyParams } from "./shared.js";
import type { TelegramActionHandlers } from "./types.js";

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
  // Three media sources, in priority order: a public URL or a Telegram
  // file_id (both passed to the Bot API as a plain string — Telegram
  // fetches/reuses server-side, no local bytes involved), else a
  // workspace file path uploaded as multipart.
  const remote = body.url ?? body.file_id;
  let file: string | import("grammy").InputFile;
  if (remote) {
    file = String(remote);
  } else {
    // Fail with guidance the model can act on, not a raw ENOENT: a
    // mistyped path is the most common media-send error, and naming
    // the alternatives (url / file_id) teaches the recovery path.
    if (!body.file_path)
      return {
        ok: false,
        error: `${action}: provide file_path (workspace file), url (public), or file_id (seen in chat)`,
      };
    const filePath = expandFsPath(String(body.file_path));
    if (!existsSync(filePath))
      return {
        ok: false,
        error: `File not found: ${filePath} — check the workspace path, or send by url/file_id instead`,
      };
    const stat = statSync(filePath);
    if (stat.size > 49 * 1024 * 1024)
      return { ok: false, error: "File too large (max 49MB)" };
    const data = readFileSync(filePath);
    file = new InputFileClass(data, basename(filePath));
  }
  const rp = replyParams(body);
  let sent;
  switch (action) {
    case "send_file":
      sent = await withRetry(() =>
        bot.api.sendDocument(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
        }),
      );
      break;
    case "send_photo":
      sent = await withRetry(() =>
        bot.api.sendPhoto(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
        }),
      );
      break;
    case "send_video":
      sent = await withRetry(() =>
        bot.api.sendVideo(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
        }),
      );
      break;
    case "send_animation":
      sent = await withRetry(() =>
        bot.api.sendAnimation(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
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
        }),
      );
      break;
    default:
      sent = await withRetry(() =>
        bot.api.sendVoice(chatId, file, {
          caption,
          parse_mode: captionParseMode,
          reply_parameters: rp,
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
      { reply_parameters: replyParams(body) },
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
      },
    );
    return {
      ok: true,
      message_id: sent.message_id,
      value: sent.dice?.value,
    };
  },
};
