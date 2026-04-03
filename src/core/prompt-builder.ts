/**
 * Prompt enrichment — adds context to raw user messages before sending to the AI.
 * Platform-agnostic; works with any messaging frontend.
 */

import { getRecentBySenderId } from "../storage/history.js";
import { getUserProfile } from "../storage/learning.js";
import { getActiveGoals } from "../storage/goals.js";
import { getChatProfile } from "../storage/relationships.js";
import { formatSmartTimestamp } from "../util/time.js";

/**
 * Enrich a DM prompt with sender metadata and learned context.
 */
export function enrichDMPrompt(
  prompt: string,
  senderName: string,
  senderId: number,
  senderUsername?: string,
): string {
  const userTag = senderUsername ? ` (@${senderUsername})` : "";
  let enriched = `[DM from ${senderName}${userTag}]\n${prompt}`;

  // Add learned context about this user
  try {
    const profile = getUserProfile(senderId);
    if (profile && profile.messageCount > 5) {
      const contextParts: string[] = [];
      if (profile.preferences.length > 0) {
        contextParts.push(`Known preferences: ${profile.preferences.join(", ")}`);
      }
      if (profile.topics.length > 0) {
        contextParts.push(`Frequent topics: ${profile.topics.join(", ")}`);
      }
      if (profile.timezone) {
        contextParts.push(`Timezone: ${profile.timezone}`);
      }
      if (contextParts.length > 0) {
        enriched += `\n\n[User context: ${contextParts.join(" | ")}]`;
      }
    }
  } catch { /* learning module not loaded yet */ }

  // Add active goals related to this user
  try {
    const goals = getActiveGoals();
    const userGoals = goals.filter(g => g.relatedUsers?.includes(senderId));
    if (userGoals.length > 0) {
      enriched += `\n[Active goals with this user: ${userGoals.map(g => g.title).join(", ")}]`;
    }
  } catch { /* goals module not loaded yet */ }

  return enriched;
}

/**
 * Enrich a group prompt with the sender's recent messages for threading context.
 */
export function enrichGroupPrompt(
  prompt: string,
  chatId: string,
  senderId: number,
): string {
  const recentMsgs = getRecentBySenderId(chatId, senderId, 5);
  let enriched: string;
  if (recentMsgs.length <= 1) {
    enriched = prompt;
  } else {
    const priorMsgs = recentMsgs.slice(0, -1);
    const senderName = priorMsgs[0].senderName;
    const contextLines = priorMsgs
      .map(
        (m) =>
          `  [${formatSmartTimestamp(m.timestamp)}] ${m.text.slice(0, 200)}`,
      )
      .join("\n");
    enriched = `[${senderName}'s recent messages in this group:\n${contextLines}]\n\n${prompt}`;
  }

  // Add learned context about the sender
  try {
    const profile = getUserProfile(senderId);
    if (profile && profile.messageCount > 10) {
      enriched += `\n[About ${profile.name}: ${profile.topics.slice(0, 3).join(", ")}${profile.preferences.length > 0 ? " | prefers: " + profile.preferences.slice(0, 2).join(", ") : ""}]`;
    }
  } catch { /* learning module not loaded yet */ }

  // Add chat topic context
  try {
    const chatProfile = getChatProfile(chatId);
    if (chatProfile && chatProfile.topTopics && chatProfile.topTopics.length > 0) {
      enriched += `\n[Chat topics: ${chatProfile.topTopics.slice(0, 5).join(", ")}]`;
    }
  } catch { /* relationships module not loaded yet */ }

  return enriched;
}
