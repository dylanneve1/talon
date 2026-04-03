/**
 * Relationship graph actions: query user networks, chat profiles, and cross-chat intelligence.
 */

import {
  getRelationship,
  getUserNetwork,
  getChatProfile,
  getMostActiveChats,
  findCommonGround,
  setChatSummary,
} from "../../../../storage/relationships.js";
import type { ActionRegistry } from "./index.js";

export function registerRelationshipActions(registry: ActionRegistry) {
  registry.set("get_relationship", async (body) => {
    const userA = Number(body.user_a);
    const userB = Number(body.user_b);
    if (!userA || !userB) return { ok: false, error: "user_a and user_b are required" };

    const rel = getRelationship(userA, userB);
    if (!rel) return { ok: true, text: `No recorded relationship between ${userA} and ${userB}.`, relationship: null };

    return {
      ok: true,
      relationship: rel,
      text: `Relationship strength: ${rel.strength.toFixed(2)}, shared chats: ${rel.sharedChats.length}, last interaction: ${rel.lastInteraction}`,
    };
  });

  registry.set("get_user_network", async (body) => {
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const limit = Number(body.limit ?? 10);

    const network = getUserNetwork(userId, limit);
    if (network.length === 0) return { ok: true, text: `No connections found for user ${userId}.`, connections: [] };

    const formatted = network.map((r) => {
      const otherId = r.userA === userId ? r.userB : r.userA;
      return `User ${otherId} — strength: ${r.strength.toFixed(2)}, shared chats: ${r.sharedChats.length}, last: ${r.lastInteraction}`;
    });

    return { ok: true, text: formatted.join("\n"), count: network.length };
  });

  registry.set("get_chat_profile", async (body) => {
    const chatId = String(body.chat_id ?? "");
    if (!chatId) return { ok: false, error: "chat_id is required" };

    const profile = getChatProfile(chatId);
    if (!profile) return { ok: true, text: `No profile found for chat ${chatId}.`, profile: null };

    return {
      ok: true,
      profile,
      text: [
        `Chat: ${profile.title ?? chatId} (${profile.type})`,
        `Messages: ${profile.messageCount}, Active users: ${profile.activeUsers.length}`,
        `Last active: ${profile.lastActive}`,
        profile.summary ? `Summary: ${profile.summary}` : null,
        profile.topTopics.length > 0 ? `Topics: ${profile.topTopics.join(", ")}` : null,
      ].filter(Boolean).join("\n"),
    };
  });

  registry.set("get_active_chats", async (body) => {
    const limit = Number(body.limit ?? 10);
    const chats = getMostActiveChats(limit);
    if (chats.length === 0) return { ok: true, text: "No active chats recorded yet.", chats: [] };

    const formatted = chats.map((c) => {
      const summary = c.summary ? ` — ${c.summary}` : "";
      return `[${c.type}] ${c.title ?? c.chatId} (${c.messageCount} msgs, ${c.activeUsers.length} users)${summary} — last: ${c.lastActive}`;
    });

    return { ok: true, text: formatted.join("\n"), count: chats.length };
  });

  registry.set("find_common_ground", async (body) => {
    const userA = Number(body.user_a);
    const userB = Number(body.user_b);
    if (!userA || !userB) return { ok: false, error: "user_a and user_b are required" };

    const result = findCommonGround(userA, userB);
    const lines: string[] = [];

    if (result.relationship) {
      lines.push(`Relationship strength: ${result.relationship.strength.toFixed(2)}`);
      if (result.relationship.context) lines.push(`Context: ${result.relationship.context}`);
    } else {
      lines.push("No direct relationship recorded.");
    }

    if (result.sharedChats.length > 0) {
      lines.push(`Shared chats (${result.sharedChats.length}):`);
      for (const c of result.sharedChats) {
        lines.push(`  - ${c.title ?? c.chatId} (${c.type})`);
      }
    }

    if (result.sharedTopics.length > 0) {
      lines.push(`Shared topics: ${result.sharedTopics.join(", ")}`);
    }

    return { ok: true, text: lines.join("\n"), ...result };
  });

  registry.set("set_chat_summary", async (body) => {
    const chatId = String(body.chat_id ?? "");
    const summary = String(body.summary ?? "");
    if (!chatId) return { ok: false, error: "chat_id is required" };
    if (!summary) return { ok: false, error: "summary is required" };

    const ok = setChatSummary(chatId, summary);
    if (!ok) return { ok: false, error: `No chat profile found for ${chatId}. Chat must have had activity first.` };
    return { ok: true, text: `Summary set for chat ${chatId}.` };
  });
}
