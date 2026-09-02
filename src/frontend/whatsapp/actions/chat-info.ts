/**
 * Chat- and member-inspection actions.
 *
 * Group data comes from `groupMetadata`, which WhatsApp serves per JID
 * and Baileys caches; DMs have no metadata endpoint, so their answers are
 * assembled from the registry and the profile endpoints.
 */

import { lookupMessage } from "../message-store.js";
import { toUserJid, tryAction } from "./shared.js";
import type { WhatsAppActionHandlers } from "./types.js";

/** Render one participant the way the other frontends render members. */
function describeParticipant(p: {
  id: string;
  admin?: string | null;
  name?: string | null;
}): string {
  const role =
    p.admin === "superadmin" ? " (owner)" : p.admin ? " (admin)" : "";
  const handle = p.id.split("@")[0];
  return p.name ? `${p.name} [${handle}]${role}` : `${handle}${role}`;
}

export const chatInfoHandlers: WhatsAppActionHandlers = {
  get_chat_info: (_body, chatId, ctx) =>
    tryAction("get_chat_info", async () => {
      const chat = ctx.chat!;
      if (!chat.isGroup) {
        return {
          ok: true,
          id: chatId,
          type: "private",
          title: chat.title ?? chat.jid.split("@")[0],
        };
      }
      const meta = await ctx.sock.groupMetadata(chat.jid);
      return {
        ok: true,
        id: chatId,
        type: "group",
        title: meta.subject,
        description: meta.desc ?? undefined,
        member_count: meta.participants.length,
        owner: meta.owner ?? undefined,
        created: meta.creation ?? undefined,
        announce_only: Boolean(meta.announce),
      };
    }),

  get_chat_admins: (_body, _chatId, ctx) =>
    tryAction("get_chat_admins", async () => {
      const chat = ctx.chat!;
      if (!chat.isGroup) {
        return { ok: true, text: "Direct message — no admins." };
      }
      const meta = await ctx.sock.groupMetadata(chat.jid);
      const admins = meta.participants.filter((p) => p.admin);
      return {
        ok: true,
        text: admins.length
          ? admins.map(describeParticipant).join("\n")
          : "No admins.",
      };
    }),

  get_chat_member_count: (_body, _chatId, ctx) =>
    tryAction("get_chat_member_count", async () => {
      const chat = ctx.chat!;
      if (!chat.isGroup) return { ok: true, count: 2, text: "2" };
      const meta = await ctx.sock.groupMetadata(chat.jid);
      return {
        ok: true,
        count: meta.participants.length,
        text: String(meta.participants.length),
      };
    }),

  list_chat_members: (body, _chatId, ctx) =>
    tryAction("list_chat_members", async () => {
      const chat = ctx.chat!;
      if (!chat.isGroup) {
        return { ok: true, text: "Direct message — just the two of you." };
      }
      const limit = Math.min(500, Number(body.limit ?? 100));
      const meta = await ctx.sock.groupMetadata(chat.jid);
      return {
        ok: true,
        text: meta.participants
          .slice(0, limit)
          .map(describeParticipant)
          .join("\n"),
      };
    }),

  get_member_info: (body, _chatId, ctx) =>
    tryAction("get_member_info", async () => {
      const jid = toUserJid(body.user_id ?? body.user_name);
      if (!jid)
        return { ok: false, error: "get_member_info: user_id required" };
      const chat = ctx.chat!;
      const lines: string[] = [`jid: ${jid}`];
      if (chat.isGroup) {
        const meta = await ctx.sock.groupMetadata(chat.jid);
        const participant = meta.participants.find(
          (p) => p.id.split("@")[0] === jid.split("@")[0],
        );
        if (!participant) {
          return { ok: false, error: `${jid} is not in this group` };
        }
        lines.push(
          `role: ${participant.admin === "superadmin" ? "owner" : (participant.admin ?? "member")}`,
        );
      }
      // Profile lookups are best-effort: privacy settings routinely hide
      // both, and a missing status is not an error.
      const status: unknown = await ctx.sock
        .fetchStatus(jid)
        .catch(() => undefined);
      // fetchStatus has returned both a bare object and a one-element
      // array across Baileys versions; accept either shape.
      const entry = (Array.isArray(status) ? status[0] : status) as
        { status?: string | { status?: string } } | undefined;
      const statusText =
        typeof entry?.status === "string"
          ? entry.status
          : entry?.status?.status;
      if (statusText) lines.push(`about: ${statusText}`);
      const picture = await ctx.sock
        .profilePictureUrl(jid, "image")
        .catch(() => undefined);
      if (picture) lines.push(`photo: ${picture}`);
      return { ok: true, text: lines.join("\n") };
    }),

  get_user_profile_photos: (body, _chatId, ctx) =>
    tryAction("get_user_profile_photos", async () => {
      const jid = toUserJid(body.user_id) ?? ctx.chat!.jid;
      const url = await ctx.sock
        .profilePictureUrl(jid, "image")
        .catch(() => undefined);
      return url
        ? { ok: true, text: url }
        : {
            ok: true,
            text: "No profile photo (or hidden by privacy settings).",
          };
    }),

  /** WhatsApp exposes no presence roster; presence is per-subscription. */
  online_count: (_body, _chatId, ctx) =>
    tryAction("online_count", async () => {
      const chat = ctx.chat!;
      if (!chat.isGroup) {
        return { ok: true, text: "Presence is only visible per contact." };
      }
      const meta = await ctx.sock.groupMetadata(chat.jid);
      return {
        ok: true,
        text:
          `WhatsApp does not report a group online count; ` +
          `${meta.participants.length} members total.`,
      };
    }),

  set_chat_title: (body, _chatId, ctx) =>
    tryAction("set_chat_title", async () => {
      const chat = ctx.chat!;
      if (!chat.isGroup) {
        return { ok: false, error: "Only group subjects can be changed" };
      }
      const title = String(body.title ?? "").trim();
      if (!title) return { ok: false, error: "set_chat_title: title required" };
      await ctx.sock.groupUpdateSubject(chat.jid, title);
      chat.title = title;
      return { ok: true };
    }),

  set_chat_description: (body, _chatId, ctx) =>
    tryAction("set_chat_description", async () => {
      const chat = ctx.chat!;
      if (!chat.isGroup) {
        return { ok: false, error: "Only groups have a description" };
      }
      await ctx.sock.groupUpdateDescription(
        chat.jid,
        String(body.description ?? ""),
      );
      return { ok: true };
    }),

  /**
   * Re-download a message's media on demand. Inbound media is already
   * saved to the workspace as it arrives; this covers anything the model
   * wants to pull again by id.
   */
  download_media: (body, _chatId, ctx) =>
    tryAction("download_media", async () => {
      const raw = body.message_id;
      const msgId = typeof raw === "number" ? raw : Number(raw);
      const stored = Number.isFinite(msgId) ? lookupMessage(msgId) : undefined;
      if (!stored || stored.chatId !== ctx.chat!.chatId) {
        return { ok: false, error: `Unknown message_id ${String(raw)}` };
      }
      if (!stored.message) {
        return {
          ok: false,
          error: `Message ${msgId} is no longer retained in full`,
        };
      }
      const { saveInboundMedia } = await import("../media-store.js");
      const saved = await saveInboundMedia(
        stored.message,
        ctx.chat!.chatId,
        msgId,
        stored.senderName,
      );
      return saved
        ? { ok: true, text: saved.filePath, file_path: saved.filePath }
        : {
            ok: false,
            error: `Message ${msgId} carries no downloadable media`,
          };
    }),
};
