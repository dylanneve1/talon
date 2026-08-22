/**
 * Media actions — images, video, GIFs, voice notes, audio, documents,
 * stickers, round video notes, albums, polls, locations, venues,
 * contacts, and dice.
 *
 * Every Telegram/Discord send type has a WhatsApp equivalent except the
 * two noted inline (dice is synthesised, albums are sent as a run of
 * messages because WhatsApp groups them client-side by timing).
 */

import type { AnyMessageContent } from "baileys";
import { toWhatsAppText } from "../formatting.js";
import {
  guessMimetype,
  resolveMediaUpload,
  resolveQuoted,
  sendContent,
  sendText,
  tryAction,
} from "./shared.js";
import type { WhatsAppActionHandlers } from "./types.js";

/** Optional caption, translated to WhatsApp's dialect. */
function caption(body: Record<string, unknown>): { caption?: string } {
  const raw = body.caption ?? body.text;
  const text = raw === undefined || raw === null ? "" : String(raw);
  return text.trim() ? { caption: toWhatsAppText(text) } : {};
}

/**
 * Build the media payload for one send action. Returns an error string
 * when the source can't be resolved, so callers report it verbatim.
 */
function buildMediaContent(
  action: string,
  body: Record<string, unknown>,
): AnyMessageContent | { error: string } {
  const resolved = resolveMediaUpload(body, action);
  if ("error" in resolved) return resolved;
  const { media, fileName } = resolved;

  switch (action) {
    case "send_photo":
      return { image: media, ...caption(body) };
    case "send_video":
      return { video: media, ...caption(body) };
    case "send_animation":
      // WhatsApp has no GIF type — a looping muted video is what its own
      // client sends when you pick a GIF.
      return { video: media, gifPlayback: true, ...caption(body) };
    case "send_video_note":
      // ptv = "picture-in-video": the round bubble.
      return { video: media, ptv: true };
    case "send_voice":
      return {
        audio: media,
        ptt: true,
        mimetype: guessMimetype(fileName, "audio/ogg; codecs=opus"),
      };
    case "send_audio":
      return {
        audio: media,
        ptt: false,
        mimetype: guessMimetype(fileName, "audio/mpeg"),
      };
    case "send_sticker":
      return { sticker: media };
    case "send_file":
    default:
      return {
        document: media,
        mimetype: guessMimetype(fileName, "application/octet-stream"),
        fileName: String(body.file_name ?? fileName),
        ...caption(body),
      };
  }
}

const sendMedia: WhatsAppActionHandlers[string] = (body, _chatId, ctx) => {
  const action = String(body.action);
  return tryAction(action, async () => {
    const content = buildMediaContent(action, body);
    if ("error" in content) return { ok: false, error: content.error };
    const quoted = resolveQuoted(body, ctx.chat!.chatId);
    return sendContent(ctx, ctx.chat!, content, quoted ? { quoted } : {});
  });
};

export const mediaHandlers: WhatsAppActionHandlers = {
  send_photo: sendMedia,
  send_video: sendMedia,
  send_animation: sendMedia,
  send_video_note: sendMedia,
  send_voice: sendMedia,
  send_audio: sendMedia,
  send_file: sendMedia,

  /**
   * A sticker needs a WhatsApp-format .webp, addressed by file_path or
   * url. Talon's saved sticker packs are Telegram file ids, which this
   * account cannot upload, so an emoji-only request sends the emoji as
   * its own message instead — WhatsApp renders a lone emoji large, which
   * is the native form of the same gesture.
   */
  send_sticker: (body, _chatId, ctx) =>
    tryAction("send_sticker", async () => {
      if (!body.file_path && !body.url) {
        const emoji = String(body.emoji ?? "").trim();
        if (!emoji) {
          return {
            ok: false,
            error:
              "send_sticker: provide file_path or url to a .webp sticker, or an emoji",
          };
        }
        return sendText(ctx, ctx.chat!, emoji);
      }
      const content = buildMediaContent("send_sticker", body);
      if ("error" in content) return { ok: false, error: content.error };
      return sendContent(ctx, ctx.chat!, content);
    }),

  /**
   * WhatsApp has no album envelope on the send path — its client groups
   * consecutive media from one sender itself, so a run of sends is the
   * native shape. The first item's id is reported, matching how the other
   * frontends treat a media group.
   */
  send_media_group: (body, _chatId, ctx) =>
    tryAction("send_media_group", async () => {
      const items = (body.media ?? []) as Array<Record<string, unknown>>;
      if (!Array.isArray(items) || items.length === 0) {
        return { ok: false, error: "send_media_group: media[] is required" };
      }
      let first: Awaited<ReturnType<typeof sendContent>> | undefined;
      for (const item of items) {
        const action =
          String(item.type ?? "photo") === "video"
            ? "send_video"
            : "send_photo";
        const content = buildMediaContent(action, item);
        if ("error" in content) return { ok: false, error: content.error };
        const result = await sendContent(ctx, ctx.chat!, content);
        first ??= result;
      }
      return first ?? { ok: true };
    }),

  send_poll: (body, _chatId, ctx) =>
    tryAction("send_poll", async () => {
      const values = (body.options ?? []) as unknown[];
      const question = String(body.question ?? "");
      if (!question || !Array.isArray(values) || values.length < 2) {
        return {
          ok: false,
          error: "send_poll: question and at least 2 options are required",
        };
      }
      return sendContent(ctx, ctx.chat!, {
        poll: {
          name: question,
          values: values.map((v) => String(v)),
          selectableCount: body.allows_multiple_answers ? values.length : 1,
        },
      });
    }),

  send_location: (body, _chatId, ctx) =>
    tryAction("send_location", async () => {
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
          ok: false,
          error: "send_location: latitude and longitude are required",
        };
      }
      return sendContent(ctx, ctx.chat!, {
        location: { degreesLatitude: latitude, degreesLongitude: longitude },
      });
    }),

  send_venue: (body, _chatId, ctx) =>
    tryAction("send_venue", async () => {
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        return {
          ok: false,
          error: "send_venue: latitude and longitude are required",
        };
      }
      // A venue is a location carrying a name and address — WhatsApp's
      // location message has both fields.
      return sendContent(ctx, ctx.chat!, {
        location: {
          degreesLatitude: latitude,
          degreesLongitude: longitude,
          name: body.title ? String(body.title) : undefined,
          address: body.address ? String(body.address) : undefined,
        },
      });
    }),

  send_contact: (body, _chatId, ctx) =>
    tryAction("send_contact", async () => {
      const phone = String(body.phone_number ?? "").replace(/[^0-9+]/g, "");
      const first = String(body.first_name ?? "").trim();
      const last = String(body.last_name ?? "").trim();
      const displayName = [first, last].filter(Boolean).join(" ") || phone;
      if (!phone) {
        return { ok: false, error: "send_contact: phone_number is required" };
      }
      // vCard 3.0 is what WhatsApp's own client emits for a shared contact.
      const vcard = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        `FN:${displayName}`,
        `TEL;type=CELL;waid=${phone.replace(/\D/g, "")}:${phone}`,
        "END:VCARD",
      ].join("\n");
      return sendContent(ctx, ctx.chat!, {
        contacts: { displayName, contacts: [{ vcard }] },
      });
    }),

  /**
   * WhatsApp has no dice message. Rolling here and sending the result
   * keeps the tool honest — the model asked for a random throw and gets
   * one, rendered the way a person would type it.
   */
  send_dice: (body, _chatId, ctx) =>
    tryAction("send_dice", async () => {
      const emoji = String(body.emoji ?? "🎲");
      const faces: Record<string, number> = {
        "🎲": 6,
        "🎯": 6,
        "🏀": 5,
        "⚽": 5,
        "🎳": 6,
        "🎰": 64,
      };
      const max = faces[emoji] ?? 6;
      const value = 1 + Math.floor(Math.random() * max);
      const result = await sendText(ctx, ctx.chat!, `${emoji} ${value}`);
      return { ...result, value };
    }),
};
