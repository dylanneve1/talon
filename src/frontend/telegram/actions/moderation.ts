/**
 * Moderation actions — the `moderate` tool's member/chat/topic operations,
 * plus profile-photo lookup.
 *
 * Handlers call the Bot API directly and let Telegram's own errors surface
 * (missing admin rights come back as descriptive 400s the model can read);
 * pre-checking rights here would just race the real check.
 */

import type { ChatPermissions } from "grammy/types";
import { toPositiveId } from "./shared.js";
import { resolveMediaInput } from "./media.js";
import { clearJoinRequest, listJoinRequests } from "../join-requests.js";
import type { TelegramActionHandlers } from "./types.js";

/** Seconds-from-now → Telegram until_date, honouring "omit = forever". */
function untilDate(minutes: unknown): number | undefined {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(Date.now() / 1000) + Math.round(n * 60);
}

/**
 * Friendly permission names → ChatPermissions. `send_media` fans out to all
 * the per-kind media flags; raw `can_*` keys pass through untouched so the
 * full API surface stays reachable.
 */
function toChatPermissions(raw: Record<string, boolean>): ChatPermissions {
  const out: Record<string, boolean> = {};
  const alias: Record<string, string[]> = {
    send_messages: ["can_send_messages"],
    send_media: [
      "can_send_audios",
      "can_send_documents",
      "can_send_photos",
      "can_send_videos",
      "can_send_video_notes",
      "can_send_voice_notes",
    ],
    send_polls: ["can_send_polls"],
    send_other: ["can_send_other_messages"],
    web_previews: ["can_add_web_page_previews"],
    change_info: ["can_change_info"],
    invite_users: ["can_invite_users"],
    pin_messages: ["can_pin_messages"],
    manage_topics: ["can_manage_topics"],
  };
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "boolean") continue;
    for (const target of alias[key] ?? (key.startsWith("can_") ? [key] : [])) {
      out[target] = value;
    }
  }
  return out;
}

/** Everything a mute takes away; unmute grants it back. */
const FULL_MEMBER_PERMISSIONS: ChatPermissions = toChatPermissions({
  send_messages: true,
  send_media: true,
  send_polls: true,
  send_other: true,
  web_previews: true,
});

/** The workaday admin kit `promote` grants; demote sets all of these false. */
const DEFAULT_ADMIN_RIGHTS = {
  can_manage_chat: true,
  can_delete_messages: true,
  can_restrict_members: true,
  can_pin_messages: true,
  can_invite_users: true,
  can_change_info: true,
  can_manage_topics: true,
  can_manage_video_chats: true,
};

export const moderationHandlers: TelegramActionHandlers = {
  moderate: async (body, chatId, ctx) => {
    const { bot, InputFileClass } = ctx;
    const op = String(body.op ?? "");
    const userId = toPositiveId(body.user_id);
    const needsUser = [
      "ban",
      "unban",
      "mute",
      "unmute",
      "promote",
      "demote",
      "set_admin_title",
      "approve_join_request",
      "decline_join_request",
    ];
    if (needsUser.includes(op) && userId === undefined)
      return { ok: false, error: `${op}: user_id is required` };

    switch (op) {
      case "ban":
        await bot.api.banChatMember(chatId, userId!, {
          until_date: untilDate(body.minutes),
          revoke_messages: body.delete_messages === true || undefined,
        });
        return { ok: true };
      case "unban":
        // only_if_banned keeps this from kicking a current member.
        await bot.api.unbanChatMember(chatId, userId!, {
          only_if_banned: true,
        });
        return { ok: true };
      case "mute":
        await bot.api.restrictChatMember(
          chatId,
          userId!,
          { can_send_messages: false },
          { until_date: untilDate(body.minutes) },
        );
        return { ok: true };
      case "unmute":
        await bot.api.restrictChatMember(
          chatId,
          userId!,
          FULL_MEMBER_PERMISSIONS,
        );
        return { ok: true };
      case "promote":
        await bot.api.promoteChatMember(chatId, userId!, DEFAULT_ADMIN_RIGHTS);
        return { ok: true };
      case "demote": {
        const revoked = Object.fromEntries(
          Object.keys(DEFAULT_ADMIN_RIGHTS).map((k) => [k, false]),
        );
        await bot.api.promoteChatMember(chatId, userId!, revoked);
        return { ok: true };
      }
      case "set_admin_title":
        await bot.api.setChatAdministratorCustomTitle(
          chatId,
          userId!,
          String(body.title ?? ""),
        );
        return { ok: true };
      case "set_permissions": {
        const raw = body.permissions;
        if (!raw || typeof raw !== "object")
          return { ok: false, error: "set_permissions: permissions required" };
        await bot.api.setChatPermissions(
          chatId,
          toChatPermissions(raw as Record<string, boolean>),
        );
        return { ok: true };
      }
      case "create_invite_link": {
        const expireMin = Number(body.expire_minutes);
        const link = await bot.api.createChatInviteLink(chatId, {
          name: body.title ? String(body.title) : undefined,
          expire_date:
            Number.isFinite(expireMin) && expireMin > 0
              ? Math.floor(Date.now() / 1000) + Math.round(expireMin * 60)
              : undefined,
          member_limit: toPositiveId(body.member_limit),
        });
        return { ok: true, invite_link: link.invite_link };
      }
      case "revoke_invite_link": {
        if (!body.link)
          return { ok: false, error: "revoke_invite_link: link required" };
        await bot.api.revokeChatInviteLink(chatId, String(body.link));
        return { ok: true };
      }
      case "approve_join_request":
        await bot.api.approveChatJoinRequest(chatId, userId!);
        clearJoinRequest(chatId, userId!);
        return { ok: true };
      case "decline_join_request":
        await bot.api.declineChatJoinRequest(chatId, userId!);
        clearJoinRequest(chatId, userId!);
        return { ok: true };
      case "list_join_requests":
        return { ok: true, requests: listJoinRequests(chatId) };
      case "set_chat_photo": {
        const resolved = resolveMediaInput(
          body,
          "set_chat_photo",
          InputFileClass,
        );
        if ("error" in resolved) return { ok: false, error: resolved.error };
        if (typeof resolved.file === "string")
          return {
            ok: false,
            error: "set_chat_photo needs a local file_path (no url/file_id)",
          };
        await bot.api.setChatPhoto(chatId, resolved.file);
        return { ok: true };
      }
      case "delete_chat_photo":
        await bot.api.deleteChatPhoto(chatId);
        return { ok: true };
      case "unpin_all":
        await bot.api.unpinAllChatMessages(chatId);
        return { ok: true };
      case "leave_chat":
        await bot.api.leaveChat(chatId);
        return { ok: true };
      case "create_topic": {
        if (!body.title)
          return { ok: false, error: "create_topic: title required" };
        const topic = await bot.api.createForumTopic(
          chatId,
          String(body.title),
        );
        return { ok: true, thread_id: topic.message_thread_id };
      }
      case "edit_topic": {
        const threadId = toPositiveId(body.thread_id);
        if (threadId === undefined)
          return { ok: false, error: "edit_topic: thread_id required" };
        await bot.api.editForumTopic(chatId, threadId, {
          name: body.title ? String(body.title) : undefined,
        });
        return { ok: true };
      }
      case "close_topic":
      case "reopen_topic":
      case "delete_topic": {
        const threadId = toPositiveId(body.thread_id);
        if (threadId === undefined)
          return { ok: false, error: `${op}: thread_id required` };
        if (op === "close_topic")
          await bot.api.closeForumTopic(chatId, threadId);
        else if (op === "reopen_topic")
          await bot.api.reopenForumTopic(chatId, threadId);
        else await bot.api.deleteForumTopic(chatId, threadId);
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unknown moderation op: ${op}` };
    }
  },

  get_user_profile_photos: async (body, _chatId, { bot }) => {
    const userId = toPositiveId(body.user_id);
    if (userId === undefined)
      return { ok: false, error: "user_id is required" };
    const limit = toPositiveId(body.limit) ?? 5;
    const photos = await bot.api.getUserProfilePhotos(userId, {
      limit: Math.min(limit, 100),
    });
    return {
      ok: true,
      total: photos.total_count,
      // Largest size of each photo; its file_id sends/downloads like media.
      file_ids: photos.photos.map((sizes) => sizes[sizes.length - 1].file_id),
    };
  },
};
