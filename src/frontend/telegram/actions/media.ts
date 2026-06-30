/**
 * Media actions — sending files/photos/videos/animations/voice/audio,
 * stickers, polls, locations, contacts, and dice.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { expandFsPath } from "../../../util/fs-path.js";
import { markdownToTelegramHtml } from "../formatting.js";
import { withRetry } from "../../../core/engine/gateway.js";
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
  const filePath = expandFsPath(String(body.file_path ?? ""));
  const caption = body.caption
    ? markdownToTelegramHtml(String(body.caption))
    : undefined;
  const captionParseMode = caption ? ("HTML" as const) : undefined;
  gateway.incrementMessages(chatId);
  {
    const stat = statSync(filePath);
    if (stat.size > 49 * 1024 * 1024)
      return { ok: false, error: "File too large (max 49MB)" };
  }
  const data = readFileSync(filePath);
  const file = new InputFileClass(data, basename(filePath));
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
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendSticker(chatId, String(body.file_id ?? ""), {
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
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_contact: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendContact(
      chatId,
      String(body.phone_number),
      String(body.first_name),
      { last_name: body.last_name as string | undefined },
    );
    return { ok: true, message_id: sent.message_id };
  },

  send_dice: async (body, chatId, { bot, gateway }) => {
    gateway.incrementMessages(chatId);
    const sent = await bot.api.sendDice(chatId, (body.emoji as string) || "🎲");
    return {
      ok: true,
      message_id: sent.message_id,
      value: sent.dice?.value,
    };
  },
};
