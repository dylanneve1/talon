/**
 * Modal submission handler — currently just the /pulse interval modal.
 */

import { type ModalSubmitInteraction, MessageFlags } from "discord.js";
import type { TalonConfig } from "../../../util/config.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import { setChatPulseInterval } from "../../../storage/chat-settings.js";
import { registerChat, enablePulse } from "../../../core/background/pulse.js";
import { isInteractionAllowed } from "../handlers/index.js";
import { parseInterval, formatDuration } from "../helpers.js";
import { logError } from "../../../util/log.js";

export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  _config: TalonConfig,
  _gateway: Gateway,
): Promise<void> {
  // Access control (same gate as components).
  const access = isInteractionAllowed(
    interaction.inGuild(),
    interaction.user.id,
    interaction.guildId,
    interaction.channelId,
  );
  if (!access.ok) {
    await interaction.reply({
      content: `⚠️ ${access.reason}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const chatId = interaction.guildId
    ? `discord_guild_${interaction.guildId}_${interaction.channelId}`
    : `discord_dm_${interaction.user.id}`;

  // ── /pulse interval modal ────────────────────────────────────────────
  if (interaction.customId === "modal:pulse-interval") {
    const raw = interaction.fields.getTextInputValue("interval").trim();
    const ms = parseInterval(raw);
    if (!ms) {
      await interaction.reply({
        content: `Could not parse interval "${raw}". Try: 30m, 2h, 90m, 1d.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (ms < 5 * 60 * 1000) {
      await interaction.reply({
        content: "Minimum interval is 5 minutes.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    setChatPulseInterval(chatId, ms);
    enablePulse(chatId);
    registerChat(chatId);
    await interaction.reply({
      content: `🔔 Pulse cooldown set to **${formatDuration(ms)}**`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Unknown modal — log + ack so Discord doesn't show "Interaction failed".
  logError("discord", `Unknown modal customId: ${interaction.customId}`);
  try {
    await interaction.reply({
      content: "Unknown form.",
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    /* ignore */
  }
}
