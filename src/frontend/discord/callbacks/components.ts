/**
 * Component (button + select menu) interaction handler.
 *
 * Settings panel callbacks update the original message in place (Discord
 * supports update() on the interaction). AI-generated buttons (`ai:` prefix)
 * are forwarded to the agent verbatim.
 *
 * Custom-id namespace:
 *   settings:done
 *   settings:model              (select menu, value=modelId)
 *   settings:effort:select      (select menu)
 *   settings:proactive:on|off
 *   pulse:on | pulse:off | pulse:interval (button → opens modal)
 *   effort:select               (select menu, standalone /effort)
 *   model:select                (select menu, standalone /model)
 *   ai:<id>                     (AI-generated buttons — forwarded to agent)
 */

import {
  type ButtonInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import type { TalonConfig } from "../../../util/config.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import {
  getChatSettings,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  resolveModelName,
  type EffortLevel,
} from "../../../storage/chat-settings.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../../core/background/pulse.js";
import {
  isInteractionAllowed,
  registerDiscordChat,
} from "../handlers/index.js";
import { renderSettingsText, EFFORT_DESCRIPTIONS } from "../helpers.js";
import { execute } from "../../../core/engine/dispatcher.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../core/models/active-model.js";
import {
  displayReasoningEffort,
  getActiveReasoningLevels,
  supportsReasoningLevel,
} from "../../shared/reasoning-levels.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import { logError } from "../../../util/log.js";
import {
  suppressMentions,
  splitMessage,
  safeSlice,
  DISCORD_MAX_TEXT,
} from "../formatting.js";
import { chatIdFromInteraction, type ComponentInteraction } from "./shared.js";

export async function handleComponentInteraction(
  interaction: ComponentInteraction,
  config: TalonConfig,
  gateway: Gateway,
): Promise<void> {
  // Access control
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

  const { chatId, numericChatId } = chatIdFromInteraction(interaction);
  registerDiscordChat({
    channelId: interaction.channelId!,
    guildId: interaction.guildId,
    userId: interaction.guildId ? null : interaction.user.id,
    numericChatId,
    chatId,
  });

  const customId = interaction.customId;

  // ── Settings panel callbacks ───────────────────────────────────────────────
  if (customId.startsWith("settings:")) {
    const parts = customId.split(":");
    const category = parts[1];

    if (category === "done") {
      try {
        await interaction.update({ components: [], content: "Done." });
      } catch {
        /* ignore */
      }
      return;
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
          return;
        }
        setChatModelForBackend(chatId, settingsBeId, resolution.storedValue);
        setChatBackend(chatId, settingsBeId);
      } else {
        setChatModelForBackend(chatId, settingsBeId, resolveModelName(value));
        setChatBackend(chatId, settingsBeId);
      }
      await refreshSettingsPanel(interaction, config, gateway, chatId);
      return;
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
        return;
      }
      await refreshSettingsPanel(interaction, config, gateway, chatId);
      return;
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
      return;
    }
  }

  // ── /pulse "Set interval…" button → opens modal ───────────────────────
  // Must come BEFORE the `pulse:` startsWith branch.
  if (customId === "pulse:interval" && interaction.isButton()) {
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
    return;
  }

  // ── /effort select-menu ────────────────────────────────────────────────
  // Must come BEFORE the `effort:` startsWith branch.
  if (customId === "effort:select" && interaction.isStringSelectMenu()) {
    const level = interaction.values[0];
    const be = resolveChatBackend(chatId, gateway?.backend);
    const beId = getBackendIdForChat(chatId);
    const reasoning = await getActiveReasoningLevels({
      chatId,
      backend: be,
      backendId: beId,
      config,
    });
    if (reasoning.levels.length === 0) {
      await interaction.update({
        content: "No valid reasoning levels found for this model.",
        components: [],
      });
      return;
    }
    if (level === "adaptive") setChatEffort(chatId, undefined);
    else if (supportsReasoningLevel(level, reasoning.levels))
      setChatEffort(chatId, level as EffortLevel);
    else {
      await interaction.update({
        content: "Invalid reasoning level for this model.",
        components: [],
      });
      return;
    }
    try {
      await interaction.update({
        content: `**Effort:** ${level}`,
        components: [],
      });
    } catch {
      /* ignore */
    }
    return;
  }

  // ── Standalone /pulse on|off buttons ──────────────────────────────────────
  if (customId.startsWith("pulse:")) {
    const val = customId.slice(6);
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
    return;
  }

  // ── /model select-menu (separate from settings) ─────────────────────────
  if (customId === "model:select" && interaction.isStringSelectMenu()) {
    const value = interaction.values[0];
    // Resolve and snapshot against the per-chat backend — never the
    // global default — so this works in channels with a backend
    // override pinned (e.g. switched to openai-agents to use
    // OpenRouter models).
    const be = resolveChatBackend(chatId, gateway?.backend);
    const beId = getBackendIdForChat(chatId);

    if (value === "reset") {
      // Clear THIS backend's slot only — other backends stay intact.
      setChatModelForBackend(chatId, beId, undefined);
    } else if (be?.models?.resolveModelInfo) {
      const resolution = await be.models?.resolveModelInfo(value);
      if (resolution.kind === "exact" && resolution.model.selectable) {
        setChatModelForBackend(chatId, beId, resolution.storedValue);
        setChatBackend(chatId, beId);
      } else {
        await interaction.reply({
          content: "Model unavailable.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    } else {
      setChatModelForBackend(chatId, beId, resolveModelName(value));
      setChatBackend(chatId, beId);
    }

    // Resolve display through the active-model helper so the panel
    // matches what queries will actually run. Null surfaces as
    // "No model selected".
    const { model: resolvedCurrent } = await resolveActiveModelForChat(
      chatId,
      be,
      beId,
      config,
    );
    if (be?.models?.getSettingsPresentation) {
      const current = resolvedCurrent ?? "";
      const pres = await be.models?.getSettingsPresentation(current, {
        callbackPrefix: "model:",
      });
      const modelInfo = resolvedCurrent
        ? await be.models?.getRawModelInfo?.(resolvedCurrent)
        : undefined;
      const displayName =
        modelInfo?.displayName ?? resolvedCurrent ?? "_No model selected_";
      const menu = new StringSelectMenuBuilder()
        .setCustomId("model:select")
        .setPlaceholder("Pick a model")
        .addOptions(
          pres.modelButtons.slice(0, 25).map((b) => ({
            label: safeSlice(b.text.replace(/^✓ /, ""), 100),
            value: safeSlice(b.callback_data.replace(/^model:/, ""), 100),
            default: b.text.startsWith("✓"),
          })),
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        menu,
      );
      try {
        await interaction.update({
          content: [`**Model:** \`${displayName}\``, ...pres.modelDetails].join(
            "\n",
          ),
          components: [row],
        });
      } catch {
        /* ignore */
      }
    }
    return;
  }

  // ── AI-generated buttons (prefixed `ai:`) → forward to agent ──────────
  if (customId.startsWith("ai:")) {
    await forwardToAgent(interaction, gateway);
    return;
  }

  // Unknown custom_id — log + silently ack so Discord doesn't show
  // "Interaction failed". This catches stale buttons from older panels.
  logError("discord", `Unknown custom_id: ${customId}`);
  try {
    await interaction.deferUpdate();
  } catch {
    /* ignore */
  }
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

async function forwardToAgent(
  interaction: ComponentInteraction,
  _gateway: Gateway,
): Promise<void> {
  // Acknowledge so Discord doesn't show "interaction failed"
  try {
    await interaction.deferUpdate();
  } catch {
    /* might already be acked */
  }

  const { chatId, numericChatId } = chatIdFromInteraction(interaction);
  const sender =
    interaction.member?.user?.username ?? interaction.user.username ?? "User";
  const isGroup = interaction.guildId !== null;
  // Strip the `ai:` prefix so the agent sees the original callback_data it
  // emitted in send_message_with_buttons, not our routing namespace.
  const rawId = interaction.customId.startsWith("ai:")
    ? interaction.customId.slice(3)
    : interaction.customId;
  const prompt = `[Button pressed] User clicked component with custom_id: "${rawId}"`;
  const chatTitle = isGroup
    ? `${interaction.guild?.name ?? interaction.guildId} #${(interaction.channel as { name?: string } | null)?.name ?? interaction.channelId}`
    : undefined;

  appendDailyLog(sender, `Button: ${rawId}`, { chatTitle });

  const onTextBlock = async (text: string) => {
    if (!text.trim()) return;
    if (!interaction.channel?.isSendable()) return;
    const chunks = splitMessage(suppressMentions(text), DISCORD_MAX_TEXT);
    for (const c of chunks) {
      try {
        await interaction.channel.send({
          content: c,
          allowedMentions: { parse: [] },
        });
      } catch (err) {
        logError(
          "discord",
          `forwardToAgent send failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  };

  try {
    await execute({
      chatId,
      numericChatId,
      prompt,
      senderName: sender,
      isGroup,
      source: "message",
      onEvent: async (event) => {
        if (event.type === "assistant_message") {
          await onTextBlock(event.text);
        }
      },
    });
  } catch (err) {
    logError(
      "discord",
      `Component → agent forward failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
