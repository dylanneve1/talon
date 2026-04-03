/**
 * Admin actions: admin log, invite links, scheduled messages, forum topics, channel management.
 */

import { Api } from "telegram";
import { getClient } from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { Gateway } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerAdminActions(
  registry: ActionRegistry,
  _gateway: Gateway,
  _recordOurMessage: (chatId: string, msgId: number) => void,
) {
  registry.set("get_admin_log", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const limit = Math.min(100, Number(body.limit ?? 20));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.channels.GetAdminLog({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any, q: body.query ? String(body.query) : "", limit,
      maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
      minId: BigInt(0) as unknown as import("big-integer").BigInteger,
    })) as any;
    const events = (result.events ?? []) as Array<{ id: unknown; date: number; userId: unknown; action: { className: string } }>;
    if (events.length === 0) return { ok: true, text: "No admin log events found." };
    const lines = events.map((e) => `[${new Date(e.date * 1000).toISOString()}] user:${e.userId} \u2014 ${e.action?.className}`);
    return { ok: true, text: lines.join("\n"), count: events.length };
  });

  registry.set("get_invite_link", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.ExportChatInvite({ peer: p as any }))) as any;
    return { ok: true, link: result.link };
  });

  registry.set("create_invite_link", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const expireDate = body.expire_date ? Number(body.expire_date) : undefined;
    const usageLimit = body.usage_limit ? Number(body.usage_limit) : undefined;
    const title = body.title ? String(body.title) : undefined;
    const requestNeeded = body.request_needed === true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.ExportChatInvite({ peer: p as any, expireDate, usageLimit, title, requestNeeded }))) as any;
    return { ok: true, link: result.link, title: result.title, expire_date: result.expireDate, usage_limit: result.usageLimit };
  });

  registry.set("revoke_invite_link", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const link = String(body.link ?? "");
    if (!link) return { ok: false, error: "link is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.EditExportedChatInvite({ peer: p as any, link, revoked: true }))) as any;
    return { ok: true, revoked_link: result.invite?.link ?? link };
  });

  registry.set("get_invite_links", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetExportedChatInvites({ peer: p as any, adminId: new Api.InputUserSelf(), limit: 20 }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = (result.invites ?? []).map((inv: any) => {
      const used = inv.usage ? ` (${inv.usage} uses)` : "";
      const limit = inv.usageLimit ? `/${inv.usageLimit}` : "";
      const exp = inv.expireDate ? ` expires ${new Date(inv.expireDate * 1000).toISOString()}` : "";
      const revoked = inv.revoked ? " [revoked]" : "";
      return `${inv.link}${used}${limit}${exp}${revoked}`;
    });
    return { ok: true, text: lines.length ? lines.join("\n") : "No invite links found.", count: lines.length };
  });

  registry.set("set_channel_username", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const username = String(body.username ?? "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.channels.UpdateUsername({ channel: p as any, username })));
    return { ok: true, username: username || null };
  });

  registry.set("set_discussion_group", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const channelPeer = body.channel_id ? Number(body.channel_id) : peer;
    const groupId = Number(body.group_id);
    if (!groupId) return { ok: false, error: "group_id (the supergroup to use as discussion) is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.channels.SetDiscussionGroup({ broadcast: channelPeer as any, group: groupId as any })));
    return { ok: true, channel_id: channelPeer, group_id: groupId };
  });

  registry.set("get_scheduled_messages", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetScheduledHistory({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any, hash: BigInt(0) as unknown as import("big-integer").BigInteger,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = (result.messages ?? []) as any[];
    if (msgs.length === 0) return { ok: true, text: "No scheduled messages.", count: 0 };
    const lines = msgs.map((m) => {
      const schedDate = m.date ? new Date(m.date * 1000).toISOString() : "unknown time";
      return `[id:${m.id} scheduled:${schedDate}] ${m.message || "(media)"}`;
    });
    return { ok: true, text: lines.join("\n"), count: msgs.length };
  });

  registry.set("delete_scheduled_message", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const rawIds = body.message_id;
    const ids: number[] = Array.isArray(rawIds) ? (rawIds as unknown[]).map(Number) : [Number(rawIds)];
    if (!ids.length || !ids[0]) return { ok: false, error: "message_id (or array) is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.messages.DeleteScheduledMessages({ peer: p as any, id: ids })));
    return { ok: true, deleted: ids.length };
  });

  registry.set("create_forum_topic", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const title = String(body.title ?? "");
    if (!title) return { ok: false, error: "title is required" };
    const iconColor = typeof body.icon_color === "number" ? body.icon_color : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.channels.CreateForumTopic({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any, title, iconColor, randomId: BigInt(Date.now()) as any,
    }))) as any;
    const topicId = result?.updates?.find?.((u: { className: string }) => u.className === "UpdateNewChannelMessage")?.message?.id ?? null;
    return { ok: true, topic_id: topicId };
  });

  registry.set("edit_forum_topic", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const topicId = Number(body.topic_id);
    if (!topicId) return { ok: false, error: "topic_id is required" };
    await withRetry(() => client!.invoke(new Api.channels.EditForumTopic({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: peer as any, topicId,
      title: body.title ? String(body.title) : undefined,
      closed: body.closed === true ? true : body.closed === false ? false : undefined,
    })));
    return { ok: true };
  });

  registry.set("close_forum_topic", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const topicId = Number(body.topic_id);
    if (!topicId) return { ok: false, error: "topic_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.channels.EditForumTopic({ channel: p as any, topicId, closed: true })));
    return { ok: true, topic_id: topicId, closed: true };
  });

  registry.set("reopen_forum_topic", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const topicId = Number(body.topic_id);
    if (!topicId) return { ok: false, error: "topic_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.channels.EditForumTopic({ channel: p as any, topicId, closed: false })));
    return { ok: true, topic_id: topicId, closed: false };
  });

  registry.set("delete_forum_topic", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const topicId = Number(body.topic_id);
    if (!topicId) return { ok: false, error: "topic_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.channels.DeleteTopicHistory({ channel: p as any, topMsgId: topicId }))) as any;
    return { ok: true, topic_id: topicId, deleted_messages: result?.pts ?? 0 };
  });

  registry.set("get_forum_topics", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const limit = Math.min(Number(body.limit ?? 50), 100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.channels.GetForumTopics({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: p as any, limit, offsetDate: 0, offsetId: 0, offsetTopic: 0,
      q: body.query ? String(body.query) : undefined,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topics = (result.topics ?? []).map((t: any) => ({
      id: t.id, title: t.title, iconEmoji: t.iconEmojiId ? String(t.iconEmojiId) : null,
      date: new Date((t.date ?? 0) * 1000).toISOString(),
      closed: !!t.closed, pinned: !!t.pinned, unreadCount: t.unreadCount ?? 0,
    }));
    return { ok: true, count: topics.length, topics };
  });

  registry.set("get_chat_invite_link_info", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    let hash = String(body.hash ?? body.link ?? "");
    if (hash.includes("t.me/+")) hash = hash.split("t.me/+").pop()!;
    else if (hash.includes("t.me/joinchat/")) hash = hash.split("t.me/joinchat/").pop()!;
    if (!hash) return { ok: false, error: "hash or link is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inviteResult = await withRetry(() => client!.invoke(new Api.messages.CheckChatInvite({ hash }))) as any;
    if (inviteResult.className === "ChatInviteAlready") {
      const chat = inviteResult.chat;
      return { ok: true, already_joined: true, chat_id: Number(chat.id), title: chat.title ?? null };
    }
    return {
      ok: true, already_joined: false, title: inviteResult.title ?? null,
      about: inviteResult.about ?? null, participants_count: inviteResult.participantsCount ?? null,
      has_photo: !!inviteResult.photo, is_broadcast: inviteResult.broadcast ?? false,
      is_megagroup: inviteResult.megagroup ?? false, request_needed: inviteResult.requestNeeded ?? false,
    };
  });

  registry.set("report_spam", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const reportPeer = body.user_id ? Number(body.user_id) : (body.chat_id ? Number(body.chat_id) : peer);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await withRetry(() => client!.invoke(new Api.messages.ReportSpam({ peer: reportPeer as any })));
    return { ok: true, reported: true };
  });
}
