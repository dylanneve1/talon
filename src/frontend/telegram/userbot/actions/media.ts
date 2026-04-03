/**
 * Media actions: send_file, send_photo, send_video, send_animation, send_voice,
 * send_audio, send_sticker, send_location, send_contact, send_album.
 */

import { statSync } from "node:fs";
import { Api } from "telegram";
import {
  sendUserbotFile,
  getClient,
} from "../client.js";
import { replyParams, extractMessageId } from "../helpers.js";
import { withRetry } from "../../../../core/gateway.js";
import type { Gateway } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerMediaActions(
  registry: ActionRegistry,
  gateway: Gateway,
  recordOurMessage: (chatId: string, msgId: number) => void,
) {
  // Shared handler for file-based media types
  const fileActions = ["send_file", "send_photo", "send_video", "send_animation", "send_voice", "send_audio"];
  for (const action of fileActions) {
    registry.set(action, async (body, chatId, peer, chatIdStr) => {
      const filePath = String(body.file_path ?? "");
      const caption = body.caption ? String(body.caption) : undefined;
      if (action === "send_file") {
        const stat = statSync(filePath);
        if (stat.size > 2000 * 1024 * 1024)
          return { ok: false, error: "File too large for Telegram (max 2GB)" };
      }
      gateway.incrementMessages(chatId);
      const type = action === "send_file" ? "document"
        : action === "send_photo" ? "photo"
        : action === "send_video" ? "video"
        : action === "send_animation" ? "animation"
        : action === "send_voice" ? "voice"
        : "audio";
      const msgId = await withRetry(() =>
        sendUserbotFile(peer, {
          filePath,
          caption,
          replyTo: replyParams(body),
          type,
          title: body.title as string | undefined,
          performer: body.performer as string | undefined,
        }),
      );
      recordOurMessage(chatIdStr, msgId);
      return { ok: true, message_id: msgId };
    });
  }

  registry.set("send_sticker", async () => {
    return { ok: false, error: "send_sticker with file_id is not supported in user mode. Use send_file with a local sticker file path (.webp / .tgs)." };
  });

  registry.set("send_location", async (body, chatId, peer, chatIdStr) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const lat = Number(body.latitude ?? body.lat ?? 0);
    const long = Number(body.longitude ?? body.lng ?? body.long ?? 0);
    if (!lat && !long) return { ok: false, error: "latitude and longitude are required" };

    const media = new Api.InputMediaGeoPoint({
      geoPoint: new Api.InputGeoPoint({ lat, long }),
    });

    gateway.incrementMessages(chatId);
    const sendResult = await withRetry(() =>
      client!.invoke(new Api.messages.SendMedia({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: peer as any,
        media,
        message: body.caption ? String(body.caption) : "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        randomId: BigInt(Date.now()) as any,
      })),
    );
    const locMsgId = extractMessageId(sendResult);
    if (locMsgId) recordOurMessage(chatIdStr, locMsgId);
    return { ok: true, message_id: locMsgId };
  });

  registry.set("send_contact", async (body, chatId, peer, chatIdStr) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };

    const phoneNumber = String(body.phone_number ?? "");
    const firstName = String(body.first_name ?? "");
    const lastName = String(body.last_name ?? "");
    const vcard = body.vcard ? String(body.vcard) : "";

    if (!phoneNumber || !firstName)
      return { ok: false, error: "phone_number and first_name are required" };

    const media = new Api.InputMediaContact({
      phoneNumber,
      firstName,
      lastName,
      vcard,
    });

    gateway.incrementMessages(chatId);
    const sendResult = await withRetry(() =>
      client!.invoke(new Api.messages.SendMedia({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: peer as any,
        media,
        message: "",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        randomId: BigInt(Date.now()) as any,
      })),
    );
    const contactMsgId = extractMessageId(sendResult);
    if (contactMsgId) recordOurMessage(chatIdStr, contactMsgId);
    return { ok: true, message_id: contactMsgId };
  });

  registry.set("send_album", async (body, chatId, peer, chatIdStr) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };

    const rawPaths = body.file_paths;
    if (!Array.isArray(rawPaths) || rawPaths.length === 0)
      return { ok: false, error: "file_paths must be a non-empty array" };
    if (rawPaths.length > 10)
      return { ok: false, error: "Albums can have at most 10 items" };

    const filePaths = (rawPaths as unknown[]).map(String);
    const caption = body.caption ? String(body.caption) : undefined;

    gateway.incrementMessages(chatId);
    const sent = await withRetry(() =>
      client!.sendFile(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer as any,
        {
          file: filePaths,
          caption: caption ?? "",
          parseMode: caption ? "html" : undefined,
        },
      ),
    );
    const albumMsgId = Array.isArray(sent) ? (sent[0] as { id?: number })?.id : (sent as { id?: number })?.id;
    if (albumMsgId) recordOurMessage(chatIdStr, albumMsgId);
    return { ok: true, message_id: albumMsgId };
  });
}
