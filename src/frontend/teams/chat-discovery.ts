/**
 * Teams chat discovery — which group chat Talon listens to, and where in
 * its history polling starts.
 */

import { log, logError } from "../../util/log.js";
import type { GraphClient } from "./graph.js";
import type { TeamsRuntime } from "./runtime.js";

/**
 * Load the stored chat, or pick one — by topic when configured, else the
 * most recent — and persist the choice for next boot.
 */
export async function resolveChatId(
  runtime: TeamsRuntime,
  graphClient: GraphClient,
  userId: string,
): Promise<string> {
  const stored = graphClient.getStoredChatId();
  if (stored) {
    log("teams", `Using chat: ${graphClient.getStoredChatTopic() || stored}`);
    return stored;
  }

  log("teams", "No chat configured, discovering...");
  const chats = await graphClient.listChats();

  if (chats.length === 0) throw new Error("No chats found");

  // Try to match by topic name if configured
  let selectedChat = chats[0];
  const { configChatTopic } = runtime;
  if (configChatTopic) {
    const match = chats.find((c) =>
      c.topic?.toLowerCase().includes(configChatTopic.toLowerCase()),
    );
    if (match) selectedChat = match;
    else
      log(
        "teams",
        `No chat matching topic "${configChatTopic}", using most recent`,
      );
  }

  const topic = selectedChat.topic || "(unnamed chat)";
  graphClient.saveChatConfig(selectedChat.id, topic, userId);
  log("teams", `Configured chat: ${topic} [${selectedChat.chatType}]`);
  return selectedChat.id;
}

/** Start after the newest existing message so old history is never replayed. */
export async function seedLastSeen(
  runtime: TeamsRuntime,
  graphClient: GraphClient,
  chatId: string,
): Promise<void> {
  try {
    const existing = await graphClient.getChatMessages(chatId, 5);
    if (existing.length > 0) {
      runtime.lastSeenMessageId = existing[0].id;
      log("teams", `Seeded last message ID: ${runtime.lastSeenMessageId}`);
    }
  } catch (err) {
    logError(
      "teams",
      `Failed to seed messages: ${err instanceof Error ? err.message : err}`,
    );
  }
}
