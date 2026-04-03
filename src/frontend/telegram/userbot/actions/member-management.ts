/**
 * Member management actions: kick, ban, restrict, promote, demote, slow mode, etc.
 */

import { Api } from "telegram";
import {
  getClient,
  getParticipantDetails as userbotParticipantDetails,
  getUserInfo as userbotGetUserInfo,
  getOnlineCount as userbotOnlineCount,
} from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { Gateway } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerMemberActions(
  registry: ActionRegistry,
  _gateway: Gateway,
  _recordOurMessage: (chatId: string, msgId: number) => void,
) {
  registry.set("kick_member", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const untilDate = typeof body.until_date === "number" ? body.until_date : 0;
    await withRetry(() =>
      client!.invoke(new Api.channels.EditBanned({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: peer as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        participant: userId as any,
        bannedRights: new Api.ChatBannedRights({
          viewMessages: true, sendMessages: true, sendMedia: true,
          sendStickers: true, sendGifs: true, sendGames: true,
          sendInline: true, sendPolls: true, changeInfo: true,
          inviteUsers: true, pinMessages: true, untilDate,
        }),
      })),
    );
    return { ok: true };
  });

  registry.set("unban_member", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    await withRetry(() =>
      client!.invoke(new Api.channels.EditBanned({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: peer as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        participant: userId as any,
        bannedRights: new Api.ChatBannedRights({
          viewMessages: false, sendMessages: false, sendMedia: false,
          sendStickers: false, sendGifs: false, sendGames: false,
          sendInline: false, sendPolls: false, changeInfo: false,
          inviteUsers: false, pinMessages: false, untilDate: 0,
        }),
      })),
    );
    return { ok: true };
  });

  registry.set("restrict_member", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const noMessages = body.no_messages === true;
    const noMedia = body.no_media === true;
    const noStickers = body.no_stickers === true;
    const noGifs = body.no_gifs === true;
    const noGames = body.no_games === true;
    const noInline = body.no_inline === true;
    const noPolls = body.no_polls === true;
    const noChangeInfo = body.no_change_info === true;
    const noInviteUsers = body.no_invite_users === true;
    const noPinMessages = body.no_pin_messages === true;
    const untilDate = typeof body.until_date === "number" ? body.until_date : 0;
    await withRetry(() =>
      client!.invoke(new Api.channels.EditBanned({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: peer as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        participant: userId as any,
        bannedRights: new Api.ChatBannedRights({
          viewMessages: false, sendMessages: noMessages, sendMedia: noMedia,
          sendStickers: noStickers, sendGifs: noGifs, sendGames: noGames,
          sendInline: noInline, sendPolls: noPolls, changeInfo: noChangeInfo,
          inviteUsers: noInviteUsers, pinMessages: noPinMessages, untilDate,
        }),
      })),
    );
    return { ok: true };
  });

  registry.set("promote_admin", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const rank = body.title ? String(body.title) : undefined;
    const isBasicGroup = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
    if (isBasicGroup) {
      await withRetry(() =>
        client!.invoke(new Api.messages.EditChatAdmin({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          chatId: Math.abs(peer) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: userId as any,
          isAdmin: true,
        })),
      );
    } else {
      await withRetry(() =>
        client!.invoke(new Api.channels.EditAdmin({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: userId as any,
          adminRights: new Api.ChatAdminRights({
            changeInfo: true, postMessages: true, editMessages: true,
            deleteMessages: true, banUsers: true, inviteUsers: true,
            pinMessages: true, addAdmins: body.can_add_admins === true,
            anonymous: body.anonymous === true, manageCall: true, other: true,
          }),
          rank: rank ?? "",
        })),
      );
    }
    return { ok: true };
  });

  registry.set("demote_admin", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const isBasicGroupDemote = peer < 0 && Math.abs(peer) < 1_000_000_000_000;
    if (isBasicGroupDemote) {
      await withRetry(() =>
        client!.invoke(new Api.messages.EditChatAdmin({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          chatId: Math.abs(peer) as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: userId as any,
          isAdmin: false,
        })),
      );
    } else {
      await withRetry(() =>
        client!.invoke(new Api.channels.EditAdmin({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          channel: peer as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          userId: userId as any,
          adminRights: new Api.ChatAdminRights({
            changeInfo: false, postMessages: false, editMessages: false,
            deleteMessages: false, banUsers: false, inviteUsers: false,
            pinMessages: false, addAdmins: false, anonymous: false,
            manageCall: false, other: false,
          }),
          rank: "",
        })),
      );
    }
    return { ok: true };
  });

  registry.set("set_member_tag", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const tag = String(body.tag ?? body.title ?? "");
    await withRetry(() =>
      client!.invoke(new Api.channels.EditAdmin({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: peer as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        userId: userId as any,
        adminRights: new Api.ChatAdminRights({
          other: false, changeInfo: false, postMessages: false,
          editMessages: false, deleteMessages: false, banUsers: false,
          inviteUsers: false, pinMessages: false, addAdmins: false,
          anonymous: false, manageCall: false,
        }),
        rank: tag,
      })),
    );
    return { ok: true };
  });

  registry.set("toggle_slow_mode", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const validSeconds = [0, 10, 30, 60, 300, 900, 3600];
    const seconds = Number(body.seconds ?? 0);
    if (!validSeconds.includes(seconds))
      return { ok: false, error: `seconds must be one of: ${validSeconds.join(", ")}` };
    await withRetry(() =>
      client!.invoke(new Api.channels.ToggleSlowMode({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: peer as any,
        seconds,
      })),
    );
    return { ok: true, slow_mode_seconds: seconds };
  });

  registry.set("online_count", async (_body, chatId) => {
    return { ok: true, text: await userbotOnlineCount({ chatId }) };
  });

  registry.set("list_known_users", async (body, chatId) => {
    return {
      ok: true,
      text: await userbotParticipantDetails({ chatId, limit: Number(body.limit ?? 50) }),
    };
  });

  registry.set("get_member_info", async (body, chatId) => {
    return {
      ok: true,
      text: await userbotGetUserInfo({ chatId, userId: Number(body.user_id) }),
    };
  });

  registry.set("get_join_requests", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const limit = Math.min(100, Number(body.limit ?? 20));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetChatInviteImporters({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      requested: true,
      limit,
      offsetDate: 0,
      offsetUser: new Api.InputUserEmpty(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const importers = (result.importers ?? []) as any[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usersMap = new Map<string, any>((result.users ?? []).map((u: any) => [String(u.id), u]));
    const formatted = importers.map((imp) => {
      const u = usersMap.get(String(imp.userId));
      const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || String(imp.userId)) : String(imp.userId);
      const date = new Date((imp.date ?? 0) * 1000).toISOString();
      return { user_id: Number(imp.userId), name, date, about: imp.about ?? null };
    });
    return { ok: true, count: formatted.length, requests: formatted };
  });

  registry.set("approve_join_request", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id (numeric Telegram user ID) is required" };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    await withRetry(() => client!.invoke(new Api.messages.HideChatJoinRequest({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      approved: true,
    })));
    return { ok: true, user_id: userId, approved: true };
  });

  registry.set("decline_join_request", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id (numeric Telegram user ID) is required" };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    await withRetry(() => client!.invoke(new Api.messages.HideChatJoinRequest({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      peer: p as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      approved: false,
    })));
    return { ok: true, user_id: userId, approved: false };
  });

  registry.set("get_admin_rights", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.channels.GetParticipants({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      channel: p as any,
      filter: new Api.ChannelParticipantsAdmins(),
      offset: 0, limit: 50,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hash: BigInt(0) as any,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usersMap = new Map<string, any>((result.users ?? []).map((u: any) => [String(u.id), u]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const admins = (result.participants ?? []).map((p2: any) => {
      const user = usersMap.get(String(p2.userId ?? ""));
      const name = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") : "?";
      const rights = p2.adminRights;
      return {
        userId: String(p2.userId), name, username: user?.username ?? null,
        rank: p2.rank ?? null,
        rights: rights ? {
          changeInfo: !!rights.changeInfo, deleteMessages: !!rights.deleteMessages,
          banUsers: !!rights.banUsers, inviteUsers: !!rights.inviteUsers,
          pinMessages: !!rights.pinMessages, addAdmins: !!rights.addAdmins,
          manageCall: !!rights.manageCall, postMessages: !!rights.postMessages,
          editMessages: !!rights.editMessages, anonymous: !!rights.anonymous,
        } : "creator",
      };
    });
    return { ok: true, count: admins.length, admins };
  });

  registry.set("get_user_activity_summary", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetCommonChats({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      userId: userId as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      maxId: BigInt(0) as any,
      limit: 20,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chats = (result.chats ?? []) as any[];
    const summary: Array<{ chatId: string; chatTitle: string; recentMessages: number }> = [];
    for (const chat of chats.slice(0, 5)) {
      try {
        const entity = await client.getEntity(Number(chat.id)).catch(() => null);
        if (!entity) continue;
        const searchResult = await client.invoke(new Api.messages.Search({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          peer: entity as any, q: "",
          filter: new Api.InputMessagesFilterEmpty(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fromId: await client.getEntity(userId) as any,
          minDate: Math.floor(Date.now() / 1000) - 86400 * 7,
          maxDate: 0, offsetId: 0, addOffset: 0,
          limit: 1, maxId: 0, minId: 0,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hash: BigInt(0) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        })) as any;
        summary.push({ chatId: String(chat.id), chatTitle: chat.title ?? "?", recentMessages: searchResult.count ?? 0 });
      } catch { continue; }
    }
    return { ok: true, user_id: userId, shared_chats: chats.length, activity: summary };
  });

  registry.set("get_read_participants", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    const msgId = Number(body.message_id);
    if (!msgId) return { ok: false, error: "message_id is required" };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await withRetry(() => client!.invoke(new Api.messages.GetMessageReadParticipants({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        peer: p as any, msgId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }))) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const readers = Array.isArray(result) ? result as any[] : [];
      return {
        ok: true, message_id: msgId, count: readers.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        readers: readers.map((r: any) => ({
          user_id: Number(r.userId ?? r),
          date: r.date ? new Date(r.date * 1000).toISOString() : null,
        })),
      };
    } catch (err) {
      return { ok: false, error: `Read participants not available: ${err instanceof Error ? err.message : String(err)}` };
    }
  });
}
