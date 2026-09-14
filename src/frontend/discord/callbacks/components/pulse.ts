/**
 * `pulse:*` — the standalone /pulse panel.
 *
 *   pulse:interval   (button → opens the interval modal)
 *   pulse:on | pulse:off
 */

import {
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../../../core/background/pulse.js";
import type { ComponentContext, ComponentInteraction } from "./types.js";

// ── /pulse "Set interval…" button → opens modal ───────────────────────
async function openIntervalModal(
  interaction: ButtonInteraction,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId("modal:pulse-interval")
    .setTitle("Pulse interval");
  const input = new TextInputBuilder()
    .setCustomId("interval")
    .setLabel("How often (min 5m)")
    .setPlaceholder("30m, 2h, 90m, 1d…")
    .setStyle(TextInputStyle.Short)
    .setMinLength(2)
    .setMaxLength(16)
    .setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(input),
  );
  await interaction.showModal(modal);
}

// ── Standalone /pulse on|off buttons ──────────────────────────────────────
async function togglePulse(
  interaction: ComponentInteraction,
  chatId: string,
): Promise<void> {
  const val = interaction.customId.slice(6);
  if (val === "on") {
    enablePulse(chatId);
    registerChat(chatId);
  } else if (val === "off") {
    disablePulse(chatId);
  }
  const enabled = isPulseEnabled(chatId);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("pulse:on")
      .setLabel(enabled ? "✓ On" : "On")
      .setStyle(enabled ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("pulse:off")
      .setLabel(!enabled ? "✓ Off" : "Off")
      .setStyle(ButtonStyle.Secondary),
  );
  try {
    await (interaction as ButtonInteraction).update({
      content: [
        `**🔔 Pulse:** ${enabled ? "on" : "off"}`,
        "",
        "Reads along every few minutes and jumps in when there's something to add.",
      ].join("\n"),
      components: [row],
    });
  } catch {
    /* ignore */
  }
}

export async function handlePulseComponent(
  interaction: ComponentInteraction,
  { chatId }: ComponentContext,
): Promise<boolean> {
  if (interaction.customId === "pulse:interval" && interaction.isButton()) {
    await openIntervalModal(interaction);
    return true;
  }
  await togglePulse(interaction, chatId);
  return true;
}
