/**
 * Member ops — ban / unban / mute / unmute / promote / demote /
 * set_admin_title, plus the join-request trio. Every op here except
 * `list_join_requests` needs a `user_id`; the router has already checked
 * that, so `userId!` is safe.
 */

import { clearJoinRequest, listJoinRequests } from "../../join-requests.js";
import {
  DEFAULT_ADMIN_RIGHTS,
  FULL_MEMBER_PERMISSIONS,
  untilDate,
} from "./permissions.js";
import type { ModerationOps } from "./types.js";

export const memberOps: ModerationOps = {
  ban: async ({ body, chatId, ctx: { bot }, userId }) => {
    await bot.api.banChatMember(chatId, userId!, {
      until_date: untilDate(body.minutes),
      revoke_messages: body.delete_messages === true || undefined,
    });
    return { ok: true };
  },
  unban: async ({ chatId, ctx: { bot }, userId }) => {
    // only_if_banned keeps this from kicking a current member.
    await bot.api.unbanChatMember(chatId, userId!, {
      only_if_banned: true,
    });
    return { ok: true };
  },
  mute: async ({ body, chatId, ctx: { bot }, userId }) => {
    await bot.api.restrictChatMember(
      chatId,
      userId!,
      { can_send_messages: false },
      { until_date: untilDate(body.minutes) },
    );
    return { ok: true };
  },
  unmute: async ({ chatId, ctx: { bot }, userId }) => {
    await bot.api.restrictChatMember(chatId, userId!, FULL_MEMBER_PERMISSIONS);
    return { ok: true };
  },
  promote: async ({ chatId, ctx: { bot }, userId }) => {
    await bot.api.promoteChatMember(chatId, userId!, DEFAULT_ADMIN_RIGHTS);
    return { ok: true };
  },
  demote: async ({ chatId, ctx: { bot }, userId }) => {
    const revoked = Object.fromEntries(
      Object.keys(DEFAULT_ADMIN_RIGHTS).map((k) => [k, false]),
    );
    await bot.api.promoteChatMember(chatId, userId!, revoked);
    return { ok: true };
  },
  set_admin_title: async ({ body, chatId, ctx: { bot }, userId }) => {
    await bot.api.setChatAdministratorCustomTitle(
      chatId,
      userId!,
      String(body.title ?? ""),
    );
    return { ok: true };
  },
  approve_join_request: async ({ chatId, ctx: { bot }, userId }) => {
    await bot.api.approveChatJoinRequest(chatId, userId!);
    clearJoinRequest(chatId, userId!);
    return { ok: true };
  },
  decline_join_request: async ({ chatId, ctx: { bot }, userId }) => {
    await bot.api.declineChatJoinRequest(chatId, userId!);
    clearJoinRequest(chatId, userId!);
    return { ok: true };
  },
  list_join_requests: async ({ chatId }) => ({
    ok: true,
    requests: listJoinRequests(chatId),
  }),
};
