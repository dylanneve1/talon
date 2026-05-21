/**
 * Component (button + select menu) interaction handlers.
 *
 * Mirrors src/frontend/telegram/callbacks.ts. Settings panel callbacks update
 * the original message in place (Discord supports update() on the interaction).
 *
 * Custom-id namespace:
 *   settings:done
 *   settings:model              (select menu, value=modelId)
 *   settings:effort:select      (select menu)
 *   settings:proactive:on|off
 *   pulse:on | pulse:off | pulse:interval (button → opens modal)
 *   effort:select               (select menu, standalone /effort)
 *   model:select                (select menu, standalone /model)
 *   ai:<id>                     (AI-generated buttons — forwarded to agent verbatim)
 *
 * Modal submissions:
 *   modal:pulse-interval        TextInput "interval"
 */

import {
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type AutocompleteInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import type { TalonConfig } from "../../util/config.js";
import type { Gateway } from "../../core/gateway.js";
import {
  getChatSettings,
  setChatModel,
  setChatModelForBackend,
  setChatBackend,
  setChatEffort,
  setChatPulseInterval,
  resolveModelName,
  EFFORT_LEVELS,
  type EffortLevel,
} from "../../storage/chat-settings.js";
import {
  registerChat,
  disablePulse,
  enablePulse,
  isPulseEnabled,
} from "../../core/pulse.js";
import { isInteractionAllowed, registerDiscordChat } from "./handlers.js";
import {
  renderSettingsText,
  parseInterval,
  formatDuration,
  EFFORT_DESCRIPTIONS,
} from "./helpers.js";
import { execute } from "../../core/dispatcher.js";
import { deriveNumericChatId } from "../../util/chat-id.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../core/backend-controller.js";
import { resolveActiveModelForChat } from "../../core/active-model.js";
import { appendDailyLog } from "../../storage/daily-log.js";
import { logError } from "../../util/log.js";
import {
  suppressMentions,
  splitMessage,
  safeSlice,
  DISCORD_MAX_TEXT,
} from "./formatting.js";

type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

function chatIdFromInteraction(interaction: ComponentInteraction): {
  chatId: string;
  numericChatId: number;
} {
  const chatId = interaction.guildId
    ? `discord_guild_${interaction.guildId}_${interaction.channelId}`
    : `discord_dm_${interaction.user.id}`;
  return { chatId, numericChatId: deriveNumericChatId(chatId) };
}

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
      } else if (settingsBe?.resolveModel) {
        const resolution = await settingsBe.resolveModel(value);
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
      if (level === "adaptive") {
        setChatEffort(chatId, undefined);
      } else if (EFFORT_LEVELS.includes(level as EffortLevel)) {
        setChatEffort(chatId, level as EffortLevel);
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
    if (level === "adaptive") setChatEffort(chatId, undefined);
    else if (EFFORT_LEVELS.includes(level as EffortLevel))
      setChatEffort(chatId, level as EffortLevel);
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
    } else if (be?.resolveModel) {
      const resolution = await be.resolveModel(value);
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
    if (be?.getSettingsPresentation) {
      const current = resolvedCurrent ?? "";
      const pres = await be.getSettingsPresentation(current, {
        callbackPrefix: "model:",
      });
      const modelInfo = resolvedCurrent
        ? await be.getModelInfo?.(resolvedCurrent)
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
  const effortName = chatSets.effort ?? "adaptive";
  const pulseOn = isPulseEnabled(chatId);

  let modelDetails: Array<string> | undefined;
  let modelButtons: Array<{ text: string; callback_data: string }> | undefined;
  // `settingsBe` already resolved above for the activeModel lookup —
  // reuse it instead of re-resolving (it points at the per-chat
  // backend, override-aware).
  if (settingsBe?.getSettingsPresentation) {
    const presModelId = resolvedActive ?? "";
    const pres = await settingsBe.getSettingsPresentation(presModelId);
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

  // Effort as a select-menu (matches standalone /effort UI).
  const effortMenu = new StringSelectMenuBuilder()
    .setCustomId("settings:effort:select")
    .setPlaceholder(`Effort: ${effortName}`)
    .addOptions(
      (["off", "low", "medium", "high", "max", "adaptive"] as const).map(
        (v) => ({
          label: v,
          value: v,
          description: EFFORT_DESCRIPTIONS[v],
          default: effortName === v,
        }),
      ),
    );
  components.push(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortMenu),
  );

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
      onTextBlock,
    });
  } catch (err) {
    logError(
      "discord",
      `Component → agent forward failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── Modal submissions ──────────────────────────────────────────────────────

export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  config: TalonConfig,
  gateway: Gateway,
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

// ── Autocomplete (/model name:) ─────────────────────────────────────────────

// Cache the model list so we don't hit getSettingsPresentation() on every
// keystroke. The backend list rarely changes between user keystrokes; 30s is
// a sweet spot between freshness and cost.
const AUTOCOMPLETE_TTL_MS = 30_000;
let modelListCache: { at: number; values: string[] } | null = null;

async function loadModelList(gateway: Gateway): Promise<string[]> {
  const now = Date.now();
  if (modelListCache && now - modelListCache.at < AUTOCOMPLETE_TTL_MS) {
    return modelListCache.values;
  }
  const be = gateway?.backend;
  if (!be?.getSettingsPresentation) return [];
  const pres = await be.getSettingsPresentation("", {
    callbackPrefix: "model:",
  });
  const values = pres.modelButtons.map((b) =>
    b.callback_data.replace(/^model:/, ""),
  );
  modelListCache = { at: now, values };
  return values;
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  gateway: Gateway,
): Promise<void> {
  if (
    interaction.commandName !== "model" ||
    interaction.options.getFocused(true).name !== "name"
  ) {
    await interaction.respond([]);
    return;
  }
  const query = interaction.options.getFocused().toLowerCase();
  try {
    const values = await loadModelList(gateway);
    const choices = values
      .filter((v) => !query || v.toLowerCase().includes(query))
      .slice(0, 25)
      .map((v) => ({ name: safeSlice(v, 100), value: safeSlice(v, 100) }));
    await interaction.respond(choices);
  } catch {
    await interaction.respond([]);
  }
}
