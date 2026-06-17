/**
 * Shared types + helpers for the Discord interaction callbacks.
 */

import type {
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { deriveNumericChatId } from "../../../util/chat-id.js";

export type ComponentInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction;

export function chatIdFromInteraction(interaction: ComponentInteraction): {
  chatId: string;
  numericChatId: number;
} {
  const chatId = interaction.guildId
    ? `discord_guild_${interaction.guildId}_${interaction.channelId}`
    : `discord_dm_${interaction.user.id}`;
  return { chatId, numericChatId: deriveNumericChatId(chatId) };
}
