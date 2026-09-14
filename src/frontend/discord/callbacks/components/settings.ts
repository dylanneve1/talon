/**
 * `settings:*` — the /settings panel. Every callback updates the original
 * message in place (Discord supports update() on the interaction).
 *
 *   settings:done
 *   settings:model              (select menu, value=modelId)
 *   settings:effort:select      (select menu)
 *   settings:proactive:on|off
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import type { TalonConfig } from "../../../../util/config.js";
import type { Gateway } from "../../../../core/engine/gateway.js";
import {
  getChatSettings,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  type EffortLevel,
} from "../../../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../../../core/models/catalog.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../../../core/background/pulse.js";
import { renderSettingsText, EFFORT_DESCRIPTIONS } from "../../helpers.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../../core/models/active-model.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../../../shared/reasoning-levels.js";
import { logError } from "../../../../util/log.js";
import { safeSlice } from "../../formatting.js";
import type { ComponentContext, ComponentInteraction } from "./types.js";

export async function handleSettingsComponent(
  interaction: ComponentInteraction,
  { config, gateway, chatId }: ComponentContext,
): Promise<boolean> {
  const parts = interaction.customId.split(":");
  const category = parts[1];

  if (category === "done") {
    try {
      await interaction.update({ components: [], content: "Done." });
    } catch {
      /* ignore */
    }
    return true;
  }

  if (category === "model" && interaction.isStringSelectMenu()) {
    const value = interaction.values[0];
    const settingsBe = resolveChatBackend(chatId, gateway?.backend);
    const settingsBeId = getBackendIdForChat(chatId);
    if (value === "reset") {
      // Clear THIS backend's slot only — other backends' picks stay.
      setChatModelForBackend(chatId, settingsBeId, undefined);
    } else if (settingsBe?.models?.resolveModelInfo) {
      const resolution = await settingsBe.models?.resolveModelInfo(value);
      if (resolution.kind !== "exact" || !resolution.model.selectable) {
        await interaction.reply({
          content: `Model unavailable.`,
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      setChatModelForBackend(chatId, settingsBeId, resolution.storedValue);
      setChatBackend(chatId, settingsBeId);
    } else {
      setChatModelForBackend(chatId, settingsBeId, resolveModelName(value));
      setChatBackend(chatId, settingsBeId);
    }
    await refreshSettingsPanel(interaction, config, gateway, chatId);
    return true;
  }

  if (category === "effort" && interaction.isStringSelectMenu()) {
    // settings:effort:select — current shape (emitted by handleSettings +
    // refreshSettingsPanel).
    const level = interaction.values[0];
    const settingsBe = resolveChatBackend(chatId, gateway?.backend);
    const settingsBeId = getBackendIdForChat(chatId);
    const reasoning = await getActiveReasoningLevels({
      chatId,
      backend: settingsBe,
      backendId: settingsBeId,
      config,
    });
    if (level === "adaptive") {
      setChatEffort(chatId, undefined);
    } else if (supportsReasoningLevel(level, reasoning.levels)) {
      setChatEffort(chatId, level as EffortLevel);
    } else {
      await interaction.reply({
        content: "No valid reasoning level for this model.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    await refreshSettingsPanel(interaction, config, gateway, chatId);
    return true;
  }

  if (category === "proactive") {
    const value = parts[2] ?? "";
    if (value === "on") {
      enablePulse(chatId);
      registerChat(chatId);
    } else {
      disablePulse(chatId);
    }
    await refreshSettingsPanel(interaction, config, gateway, chatId);
    return true;
  }

  return false;
}

async function refreshSettingsPanel(
  interaction: ComponentInteraction,
  config: TalonConfig,
  gateway: Gateway,
  chatId: string,
): Promise<void> {
  const chatSets = getChatSettings(chatId);
  const settingsBe = resolveChatBackend(chatId, gateway?.backend);
  const settingsBeId = getBackendIdForChat(chatId);
  // Match the Telegram path — resolve via the 5-step chain so the
  // panel's "Model:" line stays coherent on backend-overridden
  // chats and surfaces "No model selected" when applicable.
  const { model: resolvedActive } = await resolveActiveModelForChat(
    chatId,
    settingsBe,
    settingsBeId,
    config,
  );
  const activeModel = resolvedActive ?? "No model selected";
  const pulseOn = isPulseEnabled(chatId);
  const reasoning = await getActiveReasoningLevels({
    chatId,
    backend: settingsBe,
    backendId: settingsBeId,
    config,
  });
  const effortName = displayReasoningEffort(chatSets.effort, reasoning.levels);

  let modelDetails: Array<string> | undefined;
  let modelButtons: Array<{ text: string; callback_data: string }> | undefined;
  // `settingsBe` already resolved above for the activeModel lookup —
  // reuse it instead of re-resolving (it points at the per-chat
  // backend, override-aware).
  if (settingsBe?.models?.getSettingsPresentation) {
    const presModelId = resolvedActive ?? "";
    const pres = await settingsBe.models?.getSettingsPresentation(presModelId);
    modelDetails = pres.modelDetails;
    modelButtons = pres.modelButtons;
  }

  const components: ActionRowBuilder<
    StringSelectMenuBuilder | ButtonBuilder
  >[] = [];

  if (modelButtons?.length) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("settings:model")
      .setPlaceholder("Select a model")
      .addOptions(
        modelButtons.slice(0, 25).map((b) => ({
          label: safeSlice(b.text.replace(/^✓ /, ""), 100),
          value: safeSlice(
            b.callback_data.replace(/^settings:model:/, ""),
            100,
          ),
          default: b.text.startsWith("✓"),
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu),
    );
  }

  if (reasoning.levels.length > 0) {
    const effortMenu = new StringSelectMenuBuilder()
      .setCustomId("settings:effort:select")
      .setPlaceholder(`Effort: ${effortName}`)
      .addOptions(
        [...reasoning.levels, "adaptive"].map((v) => ({
          label: v,
          value: v,
          description: EFFORT_DESCRIPTIONS[v],
          default: effortName === v,
        })),
      );
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortMenu),
    );
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`settings:proactive:${pulseOn ? "off" : "on"}`)
        .setLabel(pulseOn ? "Pulse: ON" : "Pulse: OFF")
        .setStyle(pulseOn ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId("settings:done")
        .setLabel("Done")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  try {
    await interaction.update({
      content: renderSettingsText(
        activeModel,
        effortName,
        pulseOn,
        chatSets.pulseIntervalMs,
        modelDetails,
      ),
      components,
    });
  } catch (err) {
    logError(
      "discord",
      `Failed to refresh settings panel: ${err instanceof Error ? err.message : err}`,
    );
  }
}
