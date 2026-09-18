/**
 * Chat-level ops — permissions, invite links, chat photo, unpin_all,
 * leave_chat.
 */

import { toPositiveId } from "../shared.js";
import { resolveMediaInput } from "../media.js";
import { toChatPermissions } from "./permissions.js";
import type { ModerationOps } from "./types.js";

export const chatOps: ModerationOps = {
  set_permissions: async ({ body, chatId, ctx: { bot } }) => {
    const raw = body.permissions;
    if (!raw || typeof raw !== "object")
      return { ok: false, error: "set_permissions: permissions required" };
    await bot.api.setChatPermissions(
      chatId,
      toChatPermissions(raw as Record<string, boolean>),
    );
    return { ok: true };
  },
  create_invite_link: async ({ body, chatId, ctx: { bot } }) => {
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
  },
  revoke_invite_link: async ({ body, chatId, ctx: { bot } }) => {
    if (!body.link)
      return { ok: false, error: "revoke_invite_link: link required" };
    await bot.api.revokeChatInviteLink(chatId, String(body.link));
    return { ok: true };
  },
  set_chat_photo: async ({ body, chatId, ctx: { bot, InputFileClass } }) => {
    const resolved = resolveMediaInput(body, "set_chat_photo", InputFileClass);
    if ("error" in resolved) return { ok: false, error: resolved.error };
    if (typeof resolved.file === "string")
      return {
        ok: false,
        error: "set_chat_photo needs a local file_path (no url/file_id)",
      };
    await bot.api.setChatPhoto(chatId, resolved.file);
    return { ok: true };
  },
  delete_chat_photo: async ({ chatId, ctx: { bot } }) => {
    await bot.api.deleteChatPhoto(chatId);
    return { ok: true };
  },
  unpin_all: async ({ chatId, ctx: { bot } }) => {
    await bot.api.unpinAllChatMessages(chatId);
    return { ok: true };
  },
  leave_chat: async ({ chatId, ctx: { bot } }) => {
    await bot.api.leaveChat(chatId);
    return { ok: true };
  },
};
