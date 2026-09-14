/**
 * Outbound primitives the rest of the daemon reaches Discord through:
 * typing indicators and plain sends addressed by numeric chat id (cron,
 * pulse). Both resolve the channel via the chat registry and no-op when it
 * isn't known yet.
 */

import { logError, logWarn } from "../../util/log.js";
import { lookupDiscordChat, sendChunked } from "./handlers/index.js";
import type { DiscordRuntime } from "./runtime.js";

// sendTyping: looks up the registered Discord channel and sends typing.
// No-ops gracefully if we don't have the channel cached yet.
export async function sendTyping(
  runtime: DiscordRuntime,
  chatId: number,
): Promise<void> {
  const info = lookupDiscordChat(chatId);
  if (!info) return;
  try {
    const ch = await runtime.client.channels.fetch(info.channelId);
    if (ch && "sendTyping" in ch) {
      await (ch as { sendTyping: () => Promise<void> }).sendTyping();
    }
  } catch {
    /* channel not resolvable — ignore */
  }
}

// sendMessage (plain): used by cron and pulse to reach a specific chat.
// chatId here is the numericChatId stored in the registry.
export async function sendMessage(
  runtime: DiscordRuntime,
  chatId: number,
  text: string,
): Promise<void> {
  if (!text.trim()) return;
  const info = lookupDiscordChat(chatId);
  if (!info) {
    logWarn(
      "discord",
      `sendMessage: no registered channel for chatId ${chatId}`,
    );
    return;
  }
  try {
    const ch = await runtime.client.channels.fetch(info.channelId);
    if (
      ch &&
      "isSendable" in ch &&
      (ch as { isSendable: () => boolean }).isSendable()
    ) {
      await sendChunked(ch as never, text);
    }
  } catch (err) {
    logError(
      "discord",
      `sendMessage failed for chat ${chatId}: ${err instanceof Error ? err.message : err}`,
    );
  }
}
