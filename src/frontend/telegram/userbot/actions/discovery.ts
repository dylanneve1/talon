/**
 * Discovery actions: resolve peer, similar channels, stats, nearby, unread counts,
 * saved messages, premium gift options, read_any_chat.
 */

import { Api } from "telegram";
import { getClient } from "../client.js";
import { withRetry } from "../../../../core/gateway.js";
import type { ActionRegistry } from "./index.js";

export function registerDiscoveryActions(registry: ActionRegistry) {
  registry.set("resolve_peer", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const query = String(body.query ?? "").trim();
    if (!query) return { ok: false, error: "query is required (@username, +phone, or numeric ID)" };
    const target: number | string = /^-?\d+$/.test(query) ? Number(query) : query;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = await client.getEntity(target as any).catch(() => null);
    if (!entity) return { ok: false, error: `Could not resolve "${query}" \u2014 check the username, phone, or ID` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = entity as any;
    const type = e.className === "User" ? (e.bot ? "bot" : "user")
      : e.className === "Channel" ? (e.megagroup ? "supergroup" : "channel")
      : e.className === "Chat" ? "group" : "unknown";
    return {
      ok: true, id: Number(e.id), type, first_name: e.firstName ?? null,
      last_name: e.lastName ?? null, username: e.username ?? null,
      phone: e.phone ?? null, title: e.title ?? null,
      is_bot: e.bot ?? false, verified: e.verified ?? false,
    };
  });

  registry.set("get_similar_channels", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.channels.GetChannelRecommendations({ channel: p as any }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chats = (result.chats ?? []) as any[];
    if (chats.length === 0) return { ok: true, text: "No similar channels found.", count: 0 };
    const formatted = chats.map((c) => {
      const username = c.username ? ` @${c.username}` : "";
      const members = c.participantsCount ? ` (${c.participantsCount} members)` : "";
      return `[chat:${Number(c.id)}]${username} ${c.title ?? "(no title)"}${members}`;
    });
    return { ok: true, text: formatted.join("\n"), count: chats.length };
  });

  registry.set("get_channel_stats", async (body, _chatId, peer) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected. Ensure the userbot session is active." };
    const p = body.chat_id ? Number(body.chat_id) : peer;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await withRetry(() => client!.invoke(new Api.stats.GetBroadcastStats({ channel: p as any, dark: false })));
      } catch {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = await withRetry(() => client!.invoke(new Api.stats.GetMegagroupStats({ channel: p as any, dark: false })));
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = result as any;
      return {
        ok: true,
        period: r.period ? { min: r.period.minDate, max: r.period.maxDate } : null,
        followers: r.followers ? { current: Number(r.followers.current ?? 0), previous: Number(r.followers.previous ?? 0) } : null,
        views_per_post: r.viewsPerPost ? { current: Number(r.viewsPerPost.current ?? 0), previous: Number(r.viewsPerPost.previous ?? 0) } : null,
        shares_per_post: r.sharesPerPost ? { current: Number(r.sharesPerPost.current ?? 0) } : null,
        reactions_per_post: r.reactionsPerPost ? { current: Number(r.reactionsPerPost.current ?? 0) } : null,
        messages: r.messages ? { current: Number(r.messages.current ?? 0), previous: Number(r.messages.previous ?? 0) } : null,
      };
    } catch (err) {
      return { ok: false, error: `Stats not available: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  registry.set("get_nearby_users", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const lat = Number(body.latitude);
    const lng = Number(body.longitude);
    if (isNaN(lat) || isNaN(lng)) return { ok: false, error: "latitude and longitude are required" };
    const accuracy = body.accuracy ? Number(body.accuracy) : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nearbyResult = await withRetry(() => client!.invoke(new Api.contacts.GetLocated({
      geoPoint: new Api.InputGeoPoint({ lat, long: lng, ...(accuracy ? { accuracyRadius: accuracy } : {}) }),
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const peers = (nearbyResult.updates?.flatMap?.((u: any) => u.peers ?? []) ?? nearbyResult.peers ?? []).map((p: any) => ({
      peer_id: p.peer?.userId ? Number(p.peer.userId) : (p.peer?.channelId ? Number(p.peer.channelId) : null),
      distance: p.distance,
    }));
    return { ok: true, nearby: peers };
  });

  registry.set("get_nearby_chats", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const lat = Number(body.latitude ?? 0);
    const long = Number(body.longitude ?? 0);
    if (!lat && !long) return { ok: false, error: "latitude and longitude required" };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await client.invoke(new Api.contacts.GetLocated({ geoPoint: new Api.InputGeoPoint({ lat, long }) })) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chatsMap = new Map<string, any>((result.chats ?? []).map((c: any) => [String(c.id), c]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const peers = (result.updates ?? []).filter((u: any) => u.className === "UpdatePeerLocated")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .flatMap((u: any) => u.peers ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((p: any) => {
          const chat = chatsMap.get(String(p.peer?.channelId ?? p.peer?.chatId ?? ""));
          return {
            title: chat?.title ?? "Unknown",
            id: String(p.peer?.channelId ?? p.peer?.chatId ?? p.peer?.userId ?? "?"),
            distance: p.distance,
          };
        });
      return { ok: true, chats: peers };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registry.set("get_unread_counts", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const limit = Math.min(Number(body.limit ?? 100), 200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await withRetry(() => client!.invoke(new Api.messages.GetDialogs({
      offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(),
      limit, hash: BigInt(0) as any,
    }))) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chatsMap = new Map<string, any>((result.chats ?? []).map((c: any) => [String(c.id), c]));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usersMap = new Map<string, any>((result.users ?? []).map((u: any) => [String(u.id), u]));
    const dialogs: Array<{ chatId: string; title: string; unread: number; mentions: number }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const d of (result.dialogs ?? []) as any[]) {
      const unread = Number(d.unreadCount ?? 0);
      if (unread === 0) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = d.peer as any;
      let chatId = "";
      let title = "Unknown";
      if (p?.className === "PeerUser") {
        chatId = String(p.userId);
        const u = usersMap.get(String(p.userId));
        title = [u?.firstName, u?.lastName].filter(Boolean).join(" ") || u?.username || chatId;
      } else if (p?.className === "PeerChat") {
        chatId = String(-Number(p.chatId));
        title = chatsMap.get(String(p.chatId))?.title || chatId;
      } else if (p?.className === "PeerChannel") {
        chatId = `-100${BigInt(p.channelId).toString()}`;
        title = chatsMap.get(String(p.channelId))?.title || chatId;
      }
      dialogs.push({ chatId, title, unread, mentions: Number(d.unreadMentionsCount ?? 0) });
    }
    dialogs.sort((a, b) => b.unread - a.unread);
    return { ok: true, total_unread: dialogs.reduce((s, d) => s + d.unread, 0), chats: dialogs };
  });

  registry.set("list_saved_messages", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const limit = Math.min(Number(body.limit ?? 20), 100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = await client.getMe() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = await client.getMessages(me as any, { limit });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = msgs.map((m: any) => {
      const date = new Date((m.date ?? 0) * 1000).toISOString();
      const fwd = m.fwdFrom ? " [forwarded]" : "";
      return `[${date}] [msg:${m.id}]${fwd} ${m.message || "(media)"}`;
    });
    return { ok: true, count: msgs.length, messages: lines.join("\n") };
  });

  registry.set("search_saved_messages", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const query = String(body.query ?? "");
    if (!query) return { ok: false, error: "query is required" };
    const limit = Math.min(Number(body.limit ?? 20), 100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = await client.getMe() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = await client.getMessages(me as any, { search: query, limit });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lines = msgs.map((m: any) => {
      const date = new Date((m.date ?? 0) * 1000).toISOString();
      return `[${date}] [msg:${m.id}] ${m.message || "(media)"}`;
    });
    return { ok: true, query, count: msgs.length, messages: lines.join("\n") };
  });

  registry.set("get_premium_gift_options", async () => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await client.invoke(new Api.payments.GetPremiumGiftCodeOptions({})) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (result ?? []).map((o: any) => ({ months: o.months, currency: o.currency, amount: o.amount, users: o.users }));
      return { ok: true, options };
    } catch {
      return { ok: true, options: [], note: "Premium gift options not available" };
    }
  });

  registry.set("read_any_chat", async (body) => {
    const client = getClient();
    if (!client) return { ok: false, error: "User client not connected." };
    const target = String(body.target ?? "");
    if (!target) return { ok: false, error: "target is required (@username, +phone, or numeric ID)" };
    const targetPeer: number | string = /^-?\d+$/.test(target) ? Number(target) : target;
    const limit = Math.min(100, Number(body.limit ?? 20));
    const offsetDate = body.before ? Math.floor(new Date(String(body.before)).getTime() / 1000) : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs = await client.getMessages(targetPeer as any, { limit, offsetDate });
    if (!msgs.length) return { ok: true, text: "No messages found.", count: 0 };
    const lines = msgs.reverse().map((m) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sender = (m as any).senderId ? `[id:${Number((m as any).senderId)}]` : "[unknown]";
      const date = new Date((m.date ?? 0) * 1000).toISOString();
      const text = m.text || m.message || "(media)";
      return `[${date}] ${sender}: ${text}`;
    });
    return { ok: true, text: lines.join("\n"), count: msgs.length };
  });
}
