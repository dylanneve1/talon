/**
 * Learning actions: get/manage user profiles, insights, and active users.
 */

import {
  getUserProfile,
  getActiveUsers,
  getRecentInsights,
  addInsight,
  pruneInsights,
} from "../../../../storage/learning.js";
import type { ActionRegistry } from "./index.js";

export function registerLearningActions(registry: ActionRegistry) {
  registry.set("get_user_profile", async (body) => {
    const userId = Number(body.user_id);
    if (!userId) return { ok: false, error: "user_id is required" };
    const profile = getUserProfile(userId);
    if (!profile) return { ok: true, text: `No profile found for user ${userId}.`, profile: null };

    // Format the activity histogram into readable peak hours
    const peakHours = profile.activityHours
      .map((count, hour) => ({ hour, count }))
      .filter((h) => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((h) => `${h.hour}:00 (${h.count} msgs)`);

    return {
      ok: true,
      profile: {
        ...profile,
        peakHours,
      },
    };
  });

  registry.set("get_active_users", async (body) => {
    const hours = Number(body.hours ?? 24);
    const users = getActiveUsers(hours);
    if (users.length === 0) return { ok: true, text: `No users active in the last ${hours} hours.`, users: [] };
    const formatted = users.map((u) => {
      const username = u.username ? ` (@${u.username})` : "";
      return `[id:${u.userId}] ${u.name}${username} — ${u.messageCount} msgs, last seen ${u.lastSeen}`;
    });
    return { ok: true, text: formatted.join("\n"), count: users.length };
  });

  registry.set("get_insights", async (body) => {
    const limit = Number(body.limit ?? 10);
    const type = body.type as string | undefined;
    const validTypes = ["user_pattern", "topic_trend", "system_health", "improvement"];
    const filterType = type && validTypes.includes(type) ? type as "user_pattern" | "topic_trend" | "system_health" | "improvement" : undefined;
    const insights = getRecentInsights(limit, filterType);
    if (insights.length === 0) return { ok: true, text: "No insights yet.", insights: [] };
    const formatted = insights.map((i) => `[${i.type}] (relevance: ${i.relevance.toFixed(1)}) ${i.content} — ${i.createdAt}`);
    return { ok: true, text: formatted.join("\n"), count: insights.length };
  });

  registry.set("add_insight", async (body) => {
    const type = String(body.type ?? "");
    const content = String(body.content ?? "");
    const validTypes = ["user_pattern", "topic_trend", "system_health", "improvement"];
    if (!validTypes.includes(type)) return { ok: false, error: `type must be one of: ${validTypes.join(", ")}` };
    if (!content) return { ok: false, error: "content is required" };
    const insight = addInsight(type as "user_pattern" | "topic_trend" | "system_health" | "improvement", content);
    return { ok: true, insight };
  });

  registry.set("prune_insights", async () => {
    const pruned = pruneInsights();
    return { ok: true, pruned, remaining: getRecentInsights(999).length };
  });
}
