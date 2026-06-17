/**
 * Chat-registry accessors — map between numeric/string chat ids and the
 * Discord channel info the action handler needs to post back.
 */

import {
  chatRegistry,
  chatRegistryByString,
  type DiscordChatInfo,
} from "./state.js";

export type { DiscordChatInfo } from "./state.js";

export function registerDiscordChat(info: DiscordChatInfo): void {
  chatRegistry.set(info.numericChatId, info);
  chatRegistryByString.set(info.chatId, info);
}

export function lookupDiscordChat(
  numericChatId: number,
): DiscordChatInfo | undefined {
  return chatRegistry.get(numericChatId);
}

export function lookupDiscordChatByString(
  chatId: string,
): DiscordChatInfo | undefined {
  return chatRegistryByString.get(chatId);
}
