/**
 * Sticker actions: get/create/manage sticker sets.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { CustomFile } from "telegram/client/uploads.js";
import { Api } from "telegram";
import { getClient } from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerStickerActions(registry: ActionRegistry) {
  registry.set("get_sticker_pack", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const shortName = String(body.short_name ?? body.pack_name ?? "");
    if (!shortName) return { ok: false, error: "short_name is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.messages.GetStickerSet({
      stickerset: new Api.InputStickerSetShortName({ shortName }), hash: 0,
    })) as any;
    const set = result.set;
    const stickers = (result.documents ?? []) as Array<{ id: unknown; attributes?: Array<{ className: string; alt?: string }> }>;
    const lines = stickers.map((doc) => {
      const emoji = doc.attributes?.find((a) => a.className === "DocumentAttributeSticker")?.alt ?? "?";
      return `[doc:${doc.id}] ${emoji}`;
    });
    return { ok: true, title: set?.title, short_name: set?.shortName, count: stickers.length, text: lines.join("\n") };
  });

  registry.set("create_sticker_set", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const title = String(body.title ?? "");
    const shortName = String(body.short_name ?? "");
    const filePath = String(body.file_path ?? "");
    const emoji = String(body.emoji ?? "\uD83D\uDE42");
    if (!title || !shortName || !filePath)
      return { ok: false, error: "title, short_name, and file_path are required" };
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = ext === "tgs" ? "application/x-tgsticker" : ext === "webm" ? "video/webm" : "image/webp";
    const stickerFileSize = statSync(filePath).size;
    const uploaded = await withRetry(() =>
      client!.uploadFile({ file: new CustomFile(basename(filePath), stickerFileSize, filePath), workers: 1 }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadedMedia = await withRetry(() =>
      client!.invoke(new Api.messages.UploadMedia({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: new Api.InputPeerSelf() as any,
        media: new Api.InputMediaUploadedDocument({
          file: uploaded, mimeType,
          attributes: [
            new Api.DocumentAttributeFilename({ fileName: basename(filePath) }),
            new Api.DocumentAttributeSticker({ alt: emoji, stickerset: new Api.InputStickerSetEmpty() }),
          ],
        }),
      })),
    ) as any;
    const doc = uploadedMedia.document;
    if (!doc) return { ok: false, error: "Failed to upload sticker media" };
    await withRetry(() =>
      client!.invoke(new Api.stickers.CreateStickerSet({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        userId: new Api.InputUserSelf() as any, title, shortName,
        stickers: [new Api.InputStickerSetItem({
          document: new Api.InputDocument({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference }),
          emoji,
        })],
        emojis: mimeType !== "image/webp" || undefined,
      })),
    );
    return { ok: true, short_name: shortName };
  });

  registry.set("add_sticker_to_set", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const shortName = String(body.short_name ?? "");
    const filePath = String(body.file_path ?? "");
    const emoji = String(body.emoji ?? "\uD83D\uDE42");
    if (!shortName || !filePath) return { ok: false, error: "short_name and file_path are required" };
    const addExt = filePath.split(".").pop()?.toLowerCase() ?? "";
    const addMimeType = addExt === "tgs" ? "application/x-tgsticker" : addExt === "webm" ? "video/webm" : "image/webp";
    const addStickerSize = statSync(filePath).size;
    const uploaded = await withRetry(() =>
      client!.uploadFile({ file: new CustomFile(basename(filePath), addStickerSize, filePath), workers: 1 }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const uploadedMedia = await withRetry(() =>
      client!.invoke(new Api.messages.UploadMedia({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: new Api.InputPeerSelf() as any,
        media: new Api.InputMediaUploadedDocument({
          file: uploaded, mimeType: addMimeType,
          attributes: [
            new Api.DocumentAttributeFilename({ fileName: basename(filePath) }),
            new Api.DocumentAttributeSticker({ alt: emoji, stickerset: new Api.InputStickerSetEmpty() }),
          ],
        }),
      })),
    ) as any;
    const doc = uploadedMedia.document;
    if (!doc) return { ok: false, error: "Failed to upload sticker media" };
    await withRetry(() =>
      client!.invoke(new Api.stickers.AddStickerToSet({
        stickerset: new Api.InputStickerSetShortName({ shortName }),
        sticker: new Api.InputStickerSetItem({
          document: new Api.InputDocument({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference }),
          emoji,
        }),
      })),
    );
    return { ok: true };
  });

  registry.set("remove_sticker", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const docId = body.document_id ? String(body.document_id) : "";
    const accessHash = body.access_hash ? String(body.access_hash) : "0";
    const fileRef = body.file_reference ? Buffer.from(String(body.file_reference), "base64") : Buffer.alloc(0);
    if (!docId) return { ok: false, error: "document_id is required (from get_sticker_pack)" };
    await withRetry(() =>
      client!.invoke(new Api.stickers.RemoveStickerFromSet({
        sticker: new Api.InputDocument({
          id: BigInt(docId) as unknown as import("big-integer").BigInteger,
          accessHash: BigInt(accessHash) as unknown as import("big-integer").BigInteger,
          fileReference: fileRef,
        }),
      })),
    );
    return { ok: true };
  });

  for (const action of ["save_sticker_pack", "download_sticker", "set_sticker_set_title", "delete_sticker_set"]) {
    registry.set(action, async () => {
      return { ok: false, error: `"${action}" is not supported in userbot mode.` };
    });
  }

  registry.set("search_stickers", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const query = String(body.query ?? "");
    if (!query) return { ok: false, error: "query is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stickerResult = await withRetry(() => client!.invoke(new Api.messages.SearchStickerSets({
      q: query, excludeFeatured: false, hash: BigInt(0) as any,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sets = (stickerResult.sets ?? []).map((s: any) => ({
      id: String(s.id), title: s.title, short_name: s.shortName,
      count: s.count, animated: s.animated ?? false, video: s.videos ?? false,
    }));
    return { ok: true, sticker_sets: sets };
  });

  registry.set("get_trending_stickers", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trendResult = await withRetry(() => client!.invoke(new Api.messages.GetFeaturedStickers({ hash: BigInt(0) as any }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trendSets = (trendResult.sets ?? []).map((s: any) => ({
      id: String(s.id), title: s.title, short_name: s.shortName, count: s.count,
    }));
    return { ok: true, sticker_sets: trendSets };
  });

  registry.set("get_recent_stickers", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recentResult = await withRetry(() => client!.invoke(new Api.messages.GetRecentStickers({ hash: BigInt(0) as any }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recentStickers = (recentResult.stickers ?? []).map((s: any) => ({
      id: String(s.id), access_hash: String(s.accessHash),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      emoji: s.attributes?.find?.((a: any) => a.className === "DocumentAttributeSticker")?.alt ?? "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set_id: s.attributes?.find?.((a: any) => a.className === "DocumentAttributeSticker")?.stickerset?.id
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? String(s.attributes.find((a: any) => a.className === "DocumentAttributeSticker").stickerset.id) : null,
    }));
    return { ok: true, stickers: recentStickers, count: recentStickers.length };
  });

  registry.set("get_custom_emojis", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await withRetry(() => client!.invoke(new Api.messages.GetFeaturedEmojiStickers({ hash: BigInt(0) as any }))) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sets = (result.sets ?? []).map((s: any) => ({
        id: String(s.id), title: s.title, shortName: s.shortName, count: s.count,
      }));
      return { ok: true, count: sets.length, emoji_sets: sets };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
