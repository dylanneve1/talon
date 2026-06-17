/**
 * Chat-info, member queries, channel title/description, pinned messages,
 * Discord-native history/search, and the Telegram-only actions that return
 * null so the gateway falls through.
 */

import { ChannelType } from "discord.js";
import { logWarn } from "../../../util/log.js";
import { tryAction } from "./shared.js";
import type { DiscordActionHandlers } from "./types.js";

export const chatInfoHandlers: DiscordActionHandlers = {
  get_chat_info: (_body, _chatId, { channel }) => {
    const ch = channel!;
    if (ch.type === ChannelType.DM) {
      return {
        ok: true,
        id: ch.id,
        type: "dm",
        title: undefined,
        member_count: 2,
      };
    }
    const guildCh = ch as {
      guild?: { name: string; memberCount?: number };
    };
    return {
      ok: true,
      id: ch.id,
      type: "channel",
      title: (ch as { name?: string }).name ?? guildCh.guild?.name ?? "channel",
      member_count: guildCh.guild?.memberCount,
    };
  },

  get_chat_member_count: (_body, _chatId, { channel }) => {
    const ch = channel!;
    if (ch.type === ChannelType.DM) return { ok: true, count: 2 };
    const guildCh = ch as { guild?: { memberCount?: number } };
    return { ok: true, count: guildCh.guild?.memberCount ?? 0 };
  },

  get_chat_member: (body, _chatId, { channel }) => {
    const userId = String(body.user_id ?? "");
    const ch = channel!;
    if (ch.type === ChannelType.DM)
      return { ok: false, error: "DM has no members beyond participants" };
    const guild = (ch as { guild?: import("discord.js").Guild }).guild;
    if (!guild) return { ok: false, error: "Channel has no guild context" };
    return tryAction("get_chat_member", async () => {
      const m =
        guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
      const isOwner = m.id === guild.ownerId;
      return {
        ok: true,
        status: isOwner ? "owner" : "member",
        user: {
          id: m.user.id,
          first_name: m.displayName,
          username: m.user.username,
        },
      };
    });
  },

  get_chat_admins: (_body, _chatId, { channel }) => {
    const ch = channel!;
    if (ch.type === ChannelType.DM)
      return { ok: false, error: "DM has no admins" };
    const guild = (ch as { guild?: import("discord.js").Guild }).guild;
    if (!guild) return { ok: false, error: "No guild context" };
    return tryAction("get_chat_admins", async () => {
      // Prefer the gateway-populated cache (auto-updated on
      // GUILD_MEMBER_ADD/UPDATE/REMOVE events when GuildMembers intent is
      // declared). Fall back to a one-shot fetch if empty (cold start
      // before chunks arrive).
      if (guild.members.cache.size === 0) await guild.members.fetch();
      const admins = [...guild.members.cache.values()].filter(
        (m) =>
          m.permissions.has("Administrator") ||
          m.permissions.has("ManageGuild"),
      );
      const text = admins
        .map((a) => `${a.displayName} (@${a.user.username}) id:${a.id}`)
        .join("\n");
      return { ok: true, text };
    });
  },

  set_chat_title: (body, _chatId, { channel }) => {
    const title = String(body.title ?? "");
    const ch = channel!;
    if (
      !("setName" in ch) ||
      typeof (ch as { setName: unknown }).setName !== "function"
    ) {
      return { ok: false, error: "Channel type does not support rename" };
    }
    return tryAction("set_chat_title", async () => {
      await (ch as { setName: (n: string) => Promise<unknown> }).setName(title);
      return { ok: true };
    });
  },

  set_chat_description: (body, _chatId, { channel }) => {
    const description = String(body.description ?? "");
    const ch = channel!;
    if (
      !("setTopic" in ch) ||
      typeof (ch as { setTopic: unknown }).setTopic !== "function"
    ) {
      return {
        ok: false,
        error: "Channel type does not support description",
      };
    }
    return tryAction("set_chat_description", async () => {
      await (ch as { setTopic: (t: string) => Promise<unknown> }).setTopic(
        description,
      );
      return { ok: true };
    });
  },

  get_pinned_messages: (_body, _chatId, { channel }) => {
    return tryAction("get_pinned_messages", async () => {
      const pinned = await channel!.messages.fetchPinned();
      const lines = [...pinned.values()].map((m) => {
        const author = m.author?.username ?? "user";
        return `[${author}] msg_id:${m.id}: ${m.content.slice(0, 200)}`;
      });
      return {
        ok: true,
        text: lines.length ? lines.join("\n") : "No pinned messages.",
      };
    });
  },

  // ── History (Discord-native fetch) ─────────────────────────────────
  read_history: async (body, _chatId, { channel, client }) => {
    const limit = Math.min(100, Number(body.limit ?? 30));
    try {
      const messages = await channel!.messages.fetch({ limit });
      const sorted = [...messages.values()].sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp,
      );
      const lines = sorted.map((m) => {
        const who =
          m.author.id === client.user?.id
            ? "bot"
            : m.member?.displayName || m.author.globalName || m.author.username;
        const text = m.content || (m.attachments.size ? "(attachment)" : "");
        return `[${who}] msg_id:${m.id}: ${text.slice(0, 500)}`;
      });
      return { ok: true, text: lines.join("\n") };
    } catch (err) {
      // If Discord-level fetch fails (permission, channel gone), fall
      // through to shared in-memory history rather than surfacing the
      // error — caller has a generic fallback for this action.
      logWarn(
        "discord",
        `read_history fell through: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  },

  search_history: async (body, _chatId, { channel }) => {
    const query = String(body.query ?? "").toLowerCase();
    const limit = Math.min(100, Number(body.limit ?? 20));
    try {
      const messages = await channel!.messages.fetch({ limit: 100 });
      const matches = [...messages.values()]
        .filter((m) => m.content.toLowerCase().includes(query))
        .slice(0, limit);
      const lines = matches.map((m) => {
        const who =
          m.member?.displayName || m.author.globalName || m.author.username;
        return `[${who}] msg_id:${m.id}: ${m.content.slice(0, 300)}`;
      });
      return {
        ok: true,
        text: lines.length ? lines.join("\n") : "No matches found.",
      };
    } catch (err) {
      logWarn(
        "discord",
        `search_history fell through: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
  },

  list_known_users: (body, _chatId, { channel }) => {
    const ch = channel!;
    if (ch.type === ChannelType.DM)
      return { ok: true, text: "DM — only the participants are present." };
    const guild = (ch as { guild?: import("discord.js").Guild }).guild;
    if (!guild) return { ok: false, error: "No guild context" };
    return tryAction("list_known_users", async () => {
      const limit = Math.min(200, Number(body.limit ?? 50));
      if (guild.members.cache.size === 0) await guild.members.fetch();
      const lines = [...guild.members.cache.values()]
        .slice(0, limit)
        .map(
          (m) =>
            `${m.displayName} (@${m.user.username}) id:${m.id}${m.user.bot ? " [bot]" : ""}`,
        );
      return { ok: true, text: lines.join("\n") };
    });
  },

  get_member_info: (body, _chatId, { channel }) => {
    const userId = String(body.user_id ?? "");
    const ch = channel!;
    const guild = (ch as { guild?: import("discord.js").Guild }).guild;
    if (!guild) return { ok: false, error: "No guild context" };
    return tryAction("get_member_info", async () => {
      const m =
        guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));
      const roles = m.roles.cache.map((r) => r.name).join(", ");
      return {
        ok: true,
        text: [
          `Display: ${m.displayName}`,
          `Username: @${m.user.username}`,
          `ID: ${m.id}`,
          `Joined: ${m.joinedAt?.toISOString() ?? "?"}`,
          `Roles: ${roles || "none"}`,
          m.user.bot ? "Bot account" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    });
  },

  online_count: (_body, _chatId, { channel }) => {
    const ch = channel!;
    if (ch.type === ChannelType.DM)
      return { ok: true, text: "DM has no online concept." };
    const guild = (
      ch as {
        guild?: { approximatePresenceCount?: number; memberCount?: number };
      }
    ).guild;
    if (!guild) return { ok: false, error: "No guild context" };
    return {
      ok: true,
      text: `Approx online: ${guild.approximatePresenceCount ?? "?"} / ${guild.memberCount ?? "?"}`,
    };
  },

  // Telegram-specific actions: not supported on Discord — return null so the
  // gateway falls through to plugins/shared, or {ok:false} to surface error.
  get_user_messages: () => null,
  get_message_by_id: () => null,
  save_sticker_pack: () => null,
  get_sticker_pack: () => null,
  download_sticker: () => null,
  create_sticker_set: () => null,
  add_sticker_to_set: () => null,
  delete_sticker_from_set: () => null,
  set_sticker_set_title: () => null,
  delete_sticker_set: () => null,
  stop_poll: () => null,
  download_media: () => null,
};
