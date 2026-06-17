/**
 * Helpers shared by the Discord slash-command handlers + router.
 */

import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { deriveNumericChatId } from "../../../util/chat-id.js";
import {
  suppressMentions,
  splitMessage,
  DISCORD_MAX_TEXT,
} from "../formatting.js";

export function chatIdFromInteraction(
  interaction: ChatInputCommandInteraction,
): {
  chatId: string;
  numericChatId: number;
} {
  const chatId = interaction.guildId
    ? `discord_guild_${interaction.guildId}_${interaction.channelId}`
    : `discord_dm_${interaction.user.id}`;
  return { chatId, numericChatId: deriveNumericChatId(chatId) };
}

export async function reply(
  interaction: ChatInputCommandInteraction,
  content: string,
  ephemeral = false,
): Promise<void> {
  const safe = suppressMentions(content);
  const chunks = splitMessage(safe, DISCORD_MAX_TEXT);
  const baseOpts = {
    allowedMentions: { parse: [] as never[] },
  };
  const opts = ephemeral
    ? { ...baseOpts, flags: MessageFlags.Ephemeral as const }
    : baseOpts;
  if (!interaction.deferred && !interaction.replied) {
    await interaction.reply({ content: chunks[0], ...opts });
  } else {
    await interaction.followUp({ content: chunks[0], ...opts });
  }
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], ...opts });
  }
}

export function client(i: ChatInputCommandInteraction) {
  return i.client;
}
