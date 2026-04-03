/**
 * Chat management actions: get/set chat info, join/leave, create, invite, delete, etc.
 */

import { statSync } from "node:fs";
import { basename } from "node:path";
import { CustomFile } from "telegram/client/uploads.js";
import { Api } from "telegram";
import {
  getUserbotEntity,
  getUserbotAdmins,
  getUserbotMemberCount,
  getUserInfo as userbotGetUserInfo,
  getClient,
} from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { Gateway } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerChatActions(
  registry: ActionRegistry,
  _gateway: Gateway,
  _recordOurMessage: (chatId: string, msgId: number) => void,
) {
  registry.set("get_chat_info", async (_body, chatId, peer) => {
    const info = await getUserbotEntity(peer);
    const count = await getUserbotMemberCount(peer).catch(() => null);
    return { ok: true, ...info, member_count: count };
  });

  registry.set("get_chat_member", async (body, chatId, peer) => {
    const userId = Number(body.user_id);
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await client.invoke(new Api.channels.GetParticipant({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: peer as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        participant: userId as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      })) as any;
      const p = result.participant;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u = result.users?.[0] as any;
      const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(" ") || "(no name)") : String(userId);
      const username = u?.username ? `@${u.username}` : "";
      const role = p.className === "ChannelParticipantCreator" ? "owner"
        : p.className === "ChannelParticipantAdmin" ? "admin"
        : "member";
      const tag = p.rank ? `\nTag: ${p.rank}` : "";
      const joined = p.date ? `\nJoined: ${new Date(p.date * 1000).toISOString()}` : "";
      return { ok: true, text: `${name} ${username}\nID: ${userId}\nRole: ${role}${tag}${joined}` };
    } catch {
      const text = await userbotGetUserInfo({ chatId, userId }).catch((e) => String(e));
      return { ok: true, text };
    }
  });

  registry.set("get_chat_admins", async (_body, _chatId, peer) => {
    const text = await getUserbotAdmins(peer);
    return { ok: true, text };
  });

  registry.set("get_chat_member_count", async (_body, _chatId, peer) => {
    const count = await getUserbotMemberCount(peer);
    return { ok: true, count };
  });

  registry.set("set_chat_title", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const title = String(body.title ?? "");
    if (!title) return { ok: false, error: "title is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = await client.getEntity(peer as any) as any;
    const isChannel = entity.className === "Channel";
    if (isChannel) {
      await withRetry(() =>
        client!.invoke(new Api.channels.EditTitle({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
          title,
        })),
      );
    } else {
      await withRetry(() =>
        client!.invoke(new Api.messages.EditChatTitle({
          chatId: BigInt(peer) as unknown as import("big-integer").BigInteger,
          title,
        })),
      );
    }
    return { ok: true };
  });

  registry.set("set_chat_description", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const about = String(body.description ?? body.about ?? "");
    await withRetry(() =>
      client!.invoke(new Api.messages.EditChatAbout({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: peer as any,
        about,
      })),
    );
    return { ok: true };
  });

  registry.set("set_chat_photo", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const filePath = String(body.file_path ?? "");
    if (!filePath) return { ok: false, error: "file_path is required" };

    const chatPhotoSize = statSync(filePath).size;
    const uploaded = await withRetry(() =>
      client!.uploadFile({ file: new CustomFile(basename(filePath), chatPhotoSize, filePath), workers: 1 }),
    );
    const inputPhoto = new Api.InputChatUploadedPhoto({ file: uploaded });
    const isBasicGroupPhoto = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
    if (isBasicGroupPhoto) {
      await withRetry(() =>
        client!.invoke(new Api.messages.EditChatPhoto({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          chatId: Math.abs(peer) as any,
          photo: inputPhoto,
        })),
      );
    } else {
      await withRetry(() =>
        client!.invoke(new Api.channels.EditPhoto({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
          photo: inputPhoto,
        })),
      );
    }
    return { ok: true };
  });

  registry.set("join_chat", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const inviteOrUsername = String(body.invite_link ?? body.username ?? "");
    if (!inviteOrUsername) return { ok: false, error: "invite_link or username is required" };

    if (inviteOrUsername.startsWith("https://t.me/+") || inviteOrUsername.startsWith("https://t.me/joinchat/")) {
      const hash = inviteOrUsername.split("/").pop() ?? "";
      const cleanHash = hash.startsWith("+") ? hash.slice(1) : hash;
      await withRetry(() =>
        client!.invoke(new Api.messages.ImportChatInvite({ hash: cleanHash })),
      );
    } else {
      const username = inviteOrUsername.startsWith("@") ? inviteOrUsername.slice(1) : inviteOrUsername;
      await withRetry(() =>
        client!.invoke(new Api.channels.JoinChannel({
          channel: username as unknown as import("telegram").Api.TypeInputChannel,
        })),
      );
    }
    return { ok: true };
  });

  registry.set("leave_chat", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const isBasicGroupLeave = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
    if (isBasicGroupLeave) {
      const self = await client.getMe();
      await withRetry(() =>
        client!.invoke(new Api.messages.DeleteChatUser({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          chatId: Math.abs(peer) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: self as any,
        })),
      );
    } else {
      await withRetry(() =>
        client!.invoke(new Api.channels.LeaveChannel({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
        })),
      );
    }
    return { ok: true };
  });

  registry.set("create_group", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const title = String(body.title ?? "");
    if (!title) return { ok: false, error: "title is required" };
    const rawUserIds = body.user_ids;
    if (!Array.isArray(rawUserIds) || rawUserIds.length === 0)
      return { ok: false, error: "user_ids must be a non-empty array" };
    const userIds = (rawUserIds as unknown[]).map(Number);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() =>
      client!.invoke(new Api.messages.CreateChat({
        title,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        users: userIds as any,
      })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    const newChatId = result?.chats?.[0]?.id ? Number(result.chats[0].id) : null;
    return { ok: true, chat_id: newChatId };
  });

  registry.set("create_supergroup", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const title = String(body.title ?? "");
    if (!title) return { ok: false, error: "title is required" };
    const about = String(body.about ?? body.description ?? "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() =>
      client!.invoke(new Api.channels.CreateChannel({
        title,
        about,
        megagroup: true,
      })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;
    const newChanId = result?.chats?.[0]?.id ? Number(result.chats[0].id) : null;
    return { ok: true, chat_id: newChanId };
  });

  registry.set("invite_to_chat", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const rawUserIds = body.user_ids;
    if (!Array.isArray(rawUserIds) || rawUserIds.length === 0)
      return { ok: false, error: "user_ids must be a non-empty array" };
    const userIds = (rawUserIds as unknown[]).map(Number);
    const isBasicGroupInvite = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
    if (isBasicGroupInvite) {
      for (const uid of userIds) {
        await withRetry(() =>
          client!.invoke(new Api.messages.AddChatUser({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            chatId: Math.abs(peer) as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            userId: uid as any,
            fwdLimit: 10,
          })),
        );
      }
    } else {
      await withRetry(() =>
        client!.invoke(new Api.channels.InviteToChannel({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          users: userIds as any,
        })),
      );
    }
    return { ok: true, invited: userIds.length };
  });

  registry.set("delete_chat", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = await client.getEntity(peer as any) as any;
    const isChannel = entity.className === "Channel";
    if (isChannel) {
      await withRetry(() =>
        client!.invoke(new Api.channels.DeleteChannel({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
        })),
      );
    } else {
      await withRetry(() =>
        client!.invoke(new Api.messages.DeleteChat({
          chatId: BigInt(peer) as unknown as import("big-integer").BigInteger,
        })),
      );
    }
    return { ok: true };
  });

  registry.set("get_dialogs", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const limit = Math.min(100, Number(body.limit ?? 20));
    const dialogs = await client.getDialogs({ limit });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatted = dialogs.map((d: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e = d.entity as any;
      const title = e?.title ?? e?.firstName ?? "(unnamed)";
      const lastName = e?.lastName ? ` ${e.lastName}` : "";
      const username = e?.username ? ` @${e.username}` : "";
      const id = e?.id ? Number(e.id) : "?";
      const unread = d.unreadCount ?? 0;
      const mentions = d.unreadMentionsCount ?? 0;
      const lastMsg = d.message?.message ? ` | "${String(d.message.message).slice(0, 60)}"` : "";
      const lastDate = d.message?.date ? ` [${new Date(d.message.date * 1000).toISOString().slice(0, 10)}]` : "";
      const type = e?.className === "User" ? (e.bot ? "bot" : "user")
        : e?.className === "Channel" ? (e.megagroup ? "supergroup" : "channel")
        : e?.className === "Chat" ? "group" : "?";
      return `[chat:${id} type:${type}]${username} ${title}${lastName}${lastDate} \u2014 ${unread} unread${mentions > 0 ? ` (${mentions} mentions)` : ""}${lastMsg}`;
    });
    return { ok: true, text: formatted.join("\n"), count: dialogs.length };
  });

  registry.set("get_common_chats", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.invoke(new Api.messages.GetCommonChats({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      maxId: BigInt(0) as unknown as import("big-integer").BigInteger,
      limit: Math.min(100, Number(body.limit ?? 20)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any;
    const chats = (result.chats ?? []) as Array<{ id: unknown; title?: string; username?: string }>;
    const formatted = chats.map((c) =>
      `[chat:${Number(c.id)}] ${c.title ?? "(no title)"}${c.username ? ` @${c.username}` : ""}`,
    );
    return { ok: true, text: formatted.join("\n") || "No common chats.", count: chats.length };
  });

  registry.set("convert_to_supergroup", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const chatId = Math.abs(p);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.MigrateChat({
      chatId: BigInt(chatId) as unknown as import("big-integer").BigInteger,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    const newChatId = result?.chats?.find?.((c: { megagroup?: boolean }) => c.megagroup)?.id;
    return { ok: true, new_supergroup_id: newChatId ? `-100${BigInt(newChatId).toString()}` : null };
  });

  registry.set("set_protected_content", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const enabled = body.enabled !== false;
    await withRetry(() => client!.invoke(new Api.messages.ToggleNoForwards({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      enabled,
    })));
    return { ok: true, protected_content: enabled };
  });

  registry.set("set_auto_delete", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const validSeconds = [0, 86400, 604800, 2592000];
    const seconds = Number(body.seconds ?? 0);
    if (!validSeconds.includes(seconds))
      return { ok: false, error: `seconds must be one of: ${validSeconds.join(", ")} (0=off, 86400=1day, 604800=1week, 2592000=1month)` };
    await withRetry(() => client!.invoke(new Api.messages.SetHistoryTTL({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      period: seconds,
    })));
    const label = seconds === 0 ? "off" : seconds === 86400 ? "1 day" : seconds === 604800 ? "1 week" : "1 month";
    return { ok: true, seconds, label };
  });

  registry.set("set_chat_color", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const colorId = Number(body.color ?? 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bgEmojiId = body.background_emoji_id ? BigInt(String(body.background_emoji_id)) as any : undefined;
    const colorPeer = body.chat_id ? Number(body.chat_id) : peer;
    await withRetry(() => client!.invoke(new Api.channels.UpdateColor({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: colorPeer as any,
      color: colorId,
      ...(bgEmojiId ? { backgroundEmojiId: bgEmojiId } : {}),
    })));
    return { ok: true, color: colorId };
  });

  registry.set("set_default_send_as", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const sendAs = body.send_as;
    if (!sendAs) return { ok: false, error: "send_as is required (user_id or channel_id)" };
    const sasPeer = body.chat_id ? Number(body.chat_id) : peer;
    await withRetry(() => client!.invoke(new Api.messages.SaveDefaultSendAs({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: sasPeer as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendAs: Number(sendAs) as any,
    })));
    return { ok: true, send_as: sendAs };
  });

  registry.set("get_chat_permissions", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const entity = await client.getEntity(p).catch(() => null);
    if (!entity) return { ok: false, error: `Could not resolve ${p}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = entity as any;
    const rights = e.defaultBannedRights;
    if (!rights) return { ok: true, note: "No restricted rights configured", permissions: {} };
    return {
      ok: true,
      permissions: {
        sendMessages: !rights.sendMessages,
        sendMedia: !rights.sendMedia,
        sendStickers: !rights.sendStickers,
        sendGifs: !rights.sendGifs,
        sendGames: !rights.sendGames,
        sendInline: !rights.sendInline,
        embedLinks: !rights.embedLinks,
        sendPolls: !rights.sendPolls,
        changeInfo: !rights.changeInfo,
        inviteUsers: !rights.inviteUsers,
        pinMessages: !rights.pinMessages,
        manageTopics: !rights.manageTopics,
      },
    };
  });

  registry.set("set_chat_permissions", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perms = (body.permissions ?? body) as any;
    const rights = new Api.ChatBannedRights({
      untilDate: 0,
      sendMessages: perms.send_messages === false,
      sendMedia: perms.send_media === false,
      sendStickers: perms.send_stickers === false,
      sendGifs: perms.send_gifs === false,
      sendGames: perms.send_games === false,
      sendInline: perms.send_inline === false,
      embedLinks: perms.embed_links === false,
      sendPolls: perms.send_polls === false,
      changeInfo: perms.change_info === false,
      inviteUsers: perms.invite_users === false,
      pinMessages: perms.pin_messages === false,
      manageTopics: perms.manage_topics === false,
    });
    await withRetry(() => client!.invoke(new Api.messages.EditChatDefaultBannedRights({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      bannedRights: rights,
    })));
    return { ok: true };
  });

  registry.set("get_full_chat_info", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const entity = await client.getEntity(p).catch(() => null);
    if (!entity) return { ok: false, error: `Could not resolve ${p}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = entity as any;
    const info: Record<string, unknown> = {
      id: String(e.id),
      type: e.className,
      title: e.title ?? [e.firstName, e.lastName].filter(Boolean).join(" ") ?? "Unknown",
      username: e.username ?? null,
      isBot: e.bot ?? false,
      isVerified: e.verified ?? false,
      isPremium: e.premium ?? false,
      isScam: e.scam ?? false,
      isFake: e.fake ?? false,
      isRestricted: e.restricted ?? false,
      phone: e.phone ?? null,
      photo: e.photo ? { hasPhoto: true } : { hasPhoto: false },
      participantsCount: e.participantsCount ?? null,
      about: null,
    };
    try {
      if (e.className === "User") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const full = await client.invoke(new Api.users.GetFullUser({ id: e as any })) as any;
        info.about = full.fullUser?.about ?? null;
        info.commonChatsCount = full.fullUser?.commonChatsCount ?? 0;
        info.pinnedMsgId = full.fullUser?.pinnedMsgId ?? null;
      } else if (e.className === "Channel" || e.className === "Chat") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: e as any })) as any;
        info.about = full.fullChat?.about ?? null;
        info.memberCount = full.fullChat?.participantsCount ?? null;
        info.onlineCount = full.fullChat?.onlineCount ?? null;
        info.slowmodeSeconds = full.fullChat?.slowmodeSeconds ?? 0;
        info.linkedChatId = full.fullChat?.linkedChatId ? String(full.fullChat.linkedChatId) : null;
      }
    } catch { /* best-effort */ }
    return { ok: true, ...info };
  });

  registry.set("get_notification_settings", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.account.GetNotifySettings({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: new Api.InputNotifyPeer({ peer: p as any }) as any,
    }))) as any;
    return {
      ok: true,
      muted: !!result.silent,
      mute_until: result.muteUntil ? new Date(result.muteUntil * 1000).toISOString() : null,
      show_previews: result.showPreviews ?? true,
      sound: result.sound?.className ?? "default",
    };
  });

  registry.set("get_chat_summary", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const limit = Math.min(Number(body.limit ?? 100), 500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = await client.getMessages(p as any, { limit });
    if (!msgs.length) return { ok: true, summary: "No messages found" };

    const totalMsgs = msgs.length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const senders = new Map<string, number>();
    let mediaCount = 0;
    let replyCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of msgs as any[]) {
      const sid = String(m.senderId ?? "unknown");
      senders.set(sid, (senders.get(sid) ?? 0) + 1);
      if (m.media) mediaCount++;
      if (m.replyTo) replyCount++;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oldest = new Date(((msgs[msgs.length - 1] as any).date ?? 0) * 1000).toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newest = new Date(((msgs[0] as any).date ?? 0) * 1000).toISOString();
    const topSenders = [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    return {
      ok: true,
      total_messages: totalMsgs,
      period: { from: oldest, to: newest },
      unique_senders: senders.size,
      media_messages: mediaCount,
      replies: replyCount,
      top_senders: topSenders.map(([id, count]) => ({ userId: id, messages: count })),
    };
  });

  registry.set("get_chat_activity", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const actPeer = body.chat_id ? Number(body.chat_id) : peer;
    const actLimit = Math.min(Number(body.limit ?? 200), 500);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = await client.getMessages(actPeer as any, { limit: actLimit }) as any[];
    const counts = new Map<string, { name: string; count: number }>();
    const nameCache = new Map<string, string>();
    for (const msg of messages) {
      const sid = String(msg.senderId ?? msg.fromId?.userId ?? "unknown");
      if (!counts.has(sid)) counts.set(sid, { name: sid, count: 0 });
      counts.get(sid)!.count++;
      if (!nameCache.has(sid)) {
        const sender = msg._sender ?? msg.sender;
        if (sender) {
          const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ") || sender.username || sender.title || sid;
          nameCache.set(sid, name);
          counts.get(sid)!.name = name;
        }
      }
    }
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([userId, v]) => ({ userId, name: v.name, messages: v.count }));
    return { ok: true, sample_size: messages.length, activity: sorted };
  });

  registry.set("pin_chat", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const pinned = body.pinned !== false;
    await withRetry(() => client!.invoke(new Api.messages.ToggleDialogPin({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: new Api.InputDialogPeer({ peer: p as any }) as any,
      pinned,
    })));
    return { ok: true, pinned };
  });

  registry.set("archive_chat", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const archive = body.archive !== false;
    await withRetry(() => client!.invoke(new Api.folders.EditPeerFolders({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      folderPeers: [new Api.InputFolderPeer({ peer: p as any, folderId: archive ? 1 : 0 }) as any],
    })));
    return { ok: true, archived: archive };
  });

  registry.set("mute_chat", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const muted = body.muted !== false;
    const durationSeconds = body.duration_seconds ? Number(body.duration_seconds) : undefined;
    const muteUntil = muted
      ? (durationSeconds ? Math.floor(Date.now() / 1000) + durationSeconds : 2_147_483_647)
      : 0;
    await withRetry(() => client!.invoke(new Api.account.UpdateNotifySettings({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: new Api.InputNotifyPeer({ peer: p as any }) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      settings: new Api.InputPeerNotifySettings({ muteUntil }) as any,
    })));
    return { ok: true, muted, mute_until: muteUntil };
  });

  registry.set("check_username", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const username = String(body.username ?? "").replace(/^@/, "");
    if (!username) return { ok: false, error: "username is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const available = await withRetry(() => client!.invoke(new Api.account.CheckUsername({ username }))) as any;
    return { ok: true, username, available: !!available };
  });
}
