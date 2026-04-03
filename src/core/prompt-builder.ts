/**
 * Prompt enrichment — adds context to raw user messages before sending to the AI.
 * Platform-agnostic; works with any messaging frontend.
 */

import { getRecentBySenderId } from "../storage/history.js";
import { formatSmartTimestamp } from "../util/time.js";

/**
 * Enrich a DM prompt with sender metadata.
 */
export function enrichDMPrompt(
  prompt: string,
  senderName: string,
  senderUsername?: string,
): string {
  const userTag = senderUsername ? ` (@${senderUsername})` : "";
  return `[DM from ${senderName}${userTag}]\n${prompt}`;
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
  if (recentMsgs.length <= 1) return prompt;

  const priorMsgs = recentMsgs.slice(0, -1);
  const senderName = priorMsgs[0].senderName;
  const contextLines = priorMsgs
    .map(
      (m) => `  [${formatSmartTimestamp(m.timestamp)}] ${m.text.slice(0, 200)}`,
    )
    .join("\n");
  return `[${senderName}'s recent messages in this group:\n${contextLines}]\n\n${prompt}`;
}
