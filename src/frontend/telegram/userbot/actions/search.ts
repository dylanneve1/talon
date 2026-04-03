/**
 * Search and history actions: read_history, search, get messages, reactions, translate, etc.
 */

import { Api } from "telegram";
import {
  getClient,
  searchMessages as userbotSearch,
  getHistory as userbotHistory,
  getMessage as userbotGetMessage,
  getPinnedMessages as userbotPinnedMessages,
  downloadMessageMedia,
} from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerSearchActions(registry: ActionRegistry) {
  registry.set("read_history", async (body, chatId) => {
    return {
      ok: true,
      text: await userbotHistory({
        chatId,
        limit: Math.min(100, Number(body.limit ?? 30)),
        offsetId: body.offset_id as number | undefined,
        before: body.before as string | undefined,
      }),
    };
  });

  registry.set("search_history", async (body, chatId) => {
    return {
      ok: true,
      text: await userbotSearch({
        chatId,
        query: String(body.query ?? ""),
        limit: Math.min(100, Number(body.limit ?? 20)),
      }),
    };
  });

  registry.set("get_user_messages", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const targetUserId = body.user_id ? Number(body.user_id) : null;
    if (!targetUserId) return { ok: false, error: "user_id is required" };
    const msgLimit = Math.min(Number(body.limit ?? 20), 100);
    const entity = await client.getEntity(targetUserId).catch(() => null);
    if (!entity) return { ok: false, error: `Could not resolve user ${targetUserId}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchResult = await withRetry(() => client!.invoke(new Api.messages.Search({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any, q: "",
      filter: new Api.InputMessagesFilterEmpty(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fromId: entity as any,
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0,
      limit: msgLimit, maxId: 0, minId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = (searchResult.messages ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = msgs.map((m: any) => {
      const date = new Date((m.date ?? 0) * 1000).toISOString();
      return `[${date}] [msg:${m.id}] ${m.message || "(media)"}`;
    });
    return { ok: true, user_id: targetUserId, count: lines.length, messages: lines.join("\n") };
  });

  registry.set("get_message_by_id", async (body, chatId) => {
    return {
      ok: true,
      text: await userbotGetMessage({ chatId, messageId: Number(body.message_id) }),
    };
  });

  registry.set("get_pinned_messages", async (_body, chatId) => {
    return { ok: true, text: await userbotPinnedMessages({ chatId }) };
  });

  registry.set("search_global", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const query = String(body.query ?? "");
    if (!query) return { ok: false, error: "query is required" };
    const limit = Math.min(100, Number(body.limit ?? 20));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.messages.SearchGlobal({
      q: query, filter: new Api.InputMessagesFilterEmpty(),
      minDate: 0, maxDate: 0, offsetRate: 0,
      offsetPeer: new Api.InputPeerEmpty(), offsetId: 0, limit,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const messages = (result.messages ?? []) as Array<{
      id: number; date: number; message?: string;
      peerId?: { channelId?: unknown; chatId?: unknown; userId?: unknown };
    }>;
    if (messages.length === 0) return { ok: true, text: `No global results for "${query}".` };
    const lines = messages.map((m) => {
      const date = new Date(m.date * 1000).toISOString();
      const chatRef = m.peerId?.channelId ?? m.peerId?.chatId ?? m.peerId?.userId ?? "?";
      return `[msg:${m.id} chat:${chatRef} ${date}] ${m.message?.slice(0, 120) ?? "(media)"}`;
    });
    return { ok: true, text: lines.join("\n"), count: messages.length };
  });

  registry.set("get_message_reactions", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.messages.GetMessagesReactions({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any, id: [msgId],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const updates = (result.updates ?? []) as Array<{
      className: string;
      reactions?: { results?: Array<{ reaction?: { emoticon?: string }; count: number; chosen?: boolean }> };
    }>;
    const reactionData = updates
      .filter((u) => u.className === "UpdateMessageReactions")
      .flatMap((u) => u.reactions?.results ?? [])
      .map((r) => ({ emoji: r.reaction?.emoticon ?? "?", count: r.count, chosen: r.chosen ?? false }));
    return { ok: true, reactions: reactionData, message_id: msgId };
  });

  registry.set("get_message_context", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    const contextSize = Math.min(20, Math.max(1, Number(body.context_size ?? 5)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = await client.getMessages(p as any, { limit: contextSize, offsetId: msgId, addOffset: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const after = await client.getMessages(p as any, { limit: contextSize, offsetId: msgId + 1, addOffset: -contextSize });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = await client.getMessages(p as any, { ids: [msgId] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatMsg = (m: any) => {
      const date = new Date((m.date ?? 0) * 1000).toISOString();
      const sender = m.senderId ? `[id:${Number(m.senderId)}]` : "[unknown]";
      const mark = m.id === msgId ? " \u25C0 TARGET" : "";
      return `[msg:${m.id} ${date}] ${sender}: ${m.message || "(media)"}${mark}`;
    };
    const allMessages = [...before.reverse(), ...target, ...after.reverse()]
      .sort((a, b) => (a as { id: number }).id - (b as { id: number }).id);
    return {
      ok: true, target_id: msgId, context_size: contextSize, count: allMessages.length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text: allMessages.map((m: any) => formatMsg(m)).join("\n"),
    };
  });

  registry.set("get_message_replies", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    const repliesPeer = body.chat_id ? Number(body.chat_id) : peer;
    const repliesLimit = Math.min(Number(body.limit ?? 20), 100);
    const repliesResult = await withRetry(() => client!.invoke(new Api.messages.GetReplies({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: repliesPeer as any, msgId,
      offsetId: 0, offsetDate: 0, addOffset: 0,
      limit: repliesLimit, maxId: 0, minId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const replyMsgs = ((repliesResult as any).messages ?? []).map((m: any) => ({
      id: m.id, date: m.date, text: m.message ?? "",
      from_id: m.fromId?.userId ? Number(m.fromId.userId) : null,
    }));
    return { ok: true, replies: replyMsgs, count: replyMsgs.length };
  });

  registry.set("get_message_views", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const rawIds = body.message_id ?? body.message_ids;
    const viewsPeer = body.chat_id ? Number(body.chat_id) : peer;
    let ids: number[];
    if (Array.isArray(rawIds)) { ids = (rawIds as unknown[]).map(Number); }
    else { ids = [Number(rawIds)]; }
    if (ids.some(isNaN) || ids.length === 0) return { ok: false, error: "message_id (number or array) is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = await client.getMessages(viewsPeer as any, { ids });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const views = msgs.map((m: any) => ({ id: m?.id, views: m?.views ?? null, forwards: m?.forwards ?? null }));
    return { ok: true, messages: views };
  });

  registry.set("search_by_date", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const query = String(body.query ?? "");
    const datePeer = body.chat_id ? Number(body.chat_id) : peer;
    const searchLimit = Math.min(Number(body.limit ?? 50), 200);
    const fromDate = body.from_date ? Math.floor(Date.parse(String(body.from_date)) / 1000) : 0;
    const toDate = body.to_date ? Math.floor(Date.parse(String(body.to_date)) / 1000) : 0;
    if (!fromDate && !toDate) return { ok: false, error: "At least one of from_date or to_date is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const searchResult = await withRetry(() => client!.invoke(new Api.messages.Search({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: datePeer as any, q: query,
      filter: new Api.InputMessagesFilterEmpty(),
      minDate: fromDate, maxDate: toDate,
      offsetId: 0, addOffset: 0, limit: searchLimit, maxId: 0, minId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = (searchResult.messages ?? []).map((m: any) => ({
      id: m.id, date: m.date, text: m.message ?? "",
      from_id: m.fromId?.userId ? Number(m.fromId.userId) : null,
    }));
    return { ok: true, messages: msgs, count: searchResult.count ?? msgs.length };
  });

  registry.set("search_messages_from_user", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = body.user_id;
    if (!userId) return { ok: false, error: "user_id is required" };
    const query = String(body.query ?? "");
    const sfuPeer = body.chat_id ? Number(body.chat_id) : peer;
    const sfuLimit = Math.min(Number(body.limit ?? 50), 200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fromEntity = await client.getEntity(Number(userId) as any) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sfuResult = await withRetry(() => client!.invoke(new Api.messages.Search({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: sfuPeer as any, q: query,
      filter: new Api.InputMessagesFilterEmpty(),
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0,
      limit: sfuLimit, maxId: 0, minId: 0,
      fromId: new Api.InputPeerUser({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        userId: BigInt(fromEntity.id) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        accessHash: BigInt(fromEntity.accessHash ?? 0) as any,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sfuMsgs = (sfuResult.messages ?? []).map((m: any) => ({
      id: m.id, date: m.date, text: m.message ?? "",
      from_id: m.fromId?.userId ? Number(m.fromId.userId) : null,
    }));
    return { ok: true, messages: sfuMsgs, count: sfuResult.count ?? sfuMsgs.length };
  });

  registry.set("count_messages", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const countPeer = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countResult = await withRetry(() => client!.invoke(new Api.messages.Search({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: countPeer as any, q: "",
      filter: new Api.InputMessagesFilterEmpty(),
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0,
      limit: 1, maxId: 0, minId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    return { ok: true, total_count: countResult.count ?? 0 };
  });

  registry.set("get_message_link", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await withRetry(() => client!.invoke(new Api.channels.ExportMessageLink({ channel: p as any, id: msgId, grouped: false }))) as any;
      return { ok: true, link: result.link };
    } catch {
      return { ok: false, error: "Could not get message link \u2014 only works for channels/supergroups" };
    }
  });

  registry.set("translate_text", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const text = String(body.text ?? "");
    const toLang = String(body.to_lang ?? "en");
    if (!text) return { ok: false, error: "text is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.messages.TranslateText({
      toLang, text: [new Api.TextWithEntities({ text, entities: [] })],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const translated = (result.result?.[0]?.text ?? result.text ?? "") as string;
    return { ok: true, translated, original: text, to_lang: toLang };
  });

  registry.set("transcribe_audio", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.messages.TranscribeAudio({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: peer as any, msgId: Number(body.message_id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    return {
      ok: true, text: result.text ?? "", pending: result.pending ?? false,
      transcription_id: result.transcriptionId ? String(result.transcriptionId) : undefined,
    };
  });

  registry.set("translate_message", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    const toLang = String(body.to_lang ?? "en");
    const transPeer = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transResult = await withRetry(() => client!.invoke(new Api.messages.TranslateText({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: transPeer as any, id: [msgId], toLang,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const translations = (transResult.result ?? []).map((r: any) => ({ text: r.text ?? "" }));
    return { ok: true, to_lang: toLang, translations };
  });

  registry.set("get_web_page_preview", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const url = String(body.url ?? "");
    if (!url) return { ok: false, error: "url is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wpResult = await withRetry(() => client!.invoke(new Api.messages.GetWebPagePreview({ message: url }))) as any;
    const wp = wpResult.webpage ?? wpResult;
    return {
      ok: true, url: wp.url ?? url, display_url: wp.displayUrl ?? null,
      site_name: wp.siteName ?? null, title: wp.title ?? null,
      description: wp.description ?? null, type: wp.type ?? null, has_photo: !!wp.photo,
    };
  });

  registry.set("list_media", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const limit = Math.min(100, Number(body.limit ?? 20));
    const mediaType = String(body.type ?? "all");
    const filterMap: Record<string, unknown> = {
      photo: new Api.InputMessagesFilterPhotos(), video: new Api.InputMessagesFilterVideo(),
      document: new Api.InputMessagesFilterDocument(), voice: new Api.InputMessagesFilterVoice(),
      audio: new Api.InputMessagesFilterMusic(), all: new Api.InputMessagesFilterPhotoVideo(),
    };
    const filter = filterMap[mediaType] ?? new Api.InputMessagesFilterPhotoVideo();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.Search({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any, q: "", filter: filter as any,
      minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit, maxId: 0, minId: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = (result.messages ?? []) as any[];
    if (msgs.length === 0) return { ok: true, text: `No ${mediaType} media found.`, count: 0 };
    const lines = msgs.map((m) => {
      const date = new Date((m.date ?? 0) * 1000).toISOString();
      const mediaClass = m.media?.className ?? "unknown";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fileName = m.media?.document?.attributes?.find((a: any) => a.className === "DocumentAttributeFilename")?.fileName ?? "";
      return `[msg:${m.id} ${date}] [${mediaClass}]${fileName ? ` ${fileName}` : ""} ${m.message || ""}`.trim();
    });
    return { ok: true, text: lines.join("\n"), count: msgs.length, type: mediaType };
  });

  registry.set("download_media", async (body, chatId) => {
    return {
      ok: true,
      text: await downloadMessageMedia({ chatId, messageId: Number(body.message_id) }),
    };
  });

  registry.set("mark_as_read", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const maxId = typeof body.max_id === "number" ? body.max_id : 0;
    await withRetry(() =>
      client!.invoke(new Api.messages.ReadHistory({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: peer as any, maxId,
      })),
    );
    return { ok: true };
  });

  registry.set("mark_mentions_read", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.ReadMentions({ peer: p as any }))) as any;
    return { ok: true, pts: result?.pts ?? 0, pts_count: result?.ptsCount ?? 0 };
  });

  registry.set("mark_reactions_read", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.ReadReactions({ peer: p as any }))) as any;
    return { ok: true, pts: result?.pts ?? 0, pts_count: result?.ptsCount ?? 0 };
  });

  registry.set("get_reactions_available", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetAvailableReactions({ hash: 0 }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reactions = (result.reactions ?? []) as any[];
    const formatted = reactions.map((r) => ({ emoji: r.reaction ?? "?", title: r.title ?? "", premium: r.premium ?? false }));
    return { ok: true, count: formatted.length, reactions: formatted };
  });
}
