/**
 * `model:select` — the /model select menu (separate from settings).
 */

import { type StringSelectMenuInteraction, MessageFlags } from "discord.js";
import {
  buildModelPickerView,
  MODEL_NAV_PREFIX,
  MODEL_PAGE_SIZE,
} from "../../model-picker.js";
import {
  setChatModelForBackend,
  setChatBackend,
} from "../../../../storage/chat-settings.js";
import { resolveModelId as resolveModelName } from "../../../../core/models/catalog.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
} from "../../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../../core/models/active-model.js";
import type { ComponentContext } from "./types.js";

export async function handleModelSelect(
  interaction: StringSelectMenuInteraction,
  { config, gateway, chatId }: ComponentContext,
): Promise<void> {
  const value = interaction.values[0];
  // Resolve and snapshot against the per-chat backend — never the
  // global default — so this works in channels with a backend
  // override pinned (e.g. switched to openai-agents to use
  // OpenRouter models).
  const be = resolveChatBackend(chatId, gateway?.backend);
  const beId = getBackendIdForChat(chatId);

  // In the provider view the select carries chips, not models — picking
  // one drills into that provider rather than choosing anything.
  if (value?.startsWith("provider:") && be?.models?.getSettingsPresentation) {
    const providerId = value.slice("provider:".length);
    const { model: activeNow } = await resolveActiveModelForChat(
      chatId,
      be,
      beId,
      config,
    );
    const pres = await be.models.getSettingsPresentation(activeNow ?? "", {
      callbackPrefix: "model:",
      navCallbackPrefix: MODEL_NAV_PREFIX,
      pageSize: MODEL_PAGE_SIZE,
      provider: providerId,
    });
    const view = buildModelPickerView(
      pres,
      activeNow ?? "_No model selected_",
      beId,
    );
    try {
      await interaction.update({
        content: view.content,
        components: view.components,
      });
    } catch {
      /* ignore */
    }
    return;
  }

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
      navCallbackPrefix: MODEL_NAV_PREFIX,
      pageSize: MODEL_PAGE_SIZE,
    });
    const modelInfo = resolvedCurrent
      ? await be.models?.getRawModelInfo?.(resolvedCurrent)
      : undefined;
    const displayName =
      modelInfo?.displayName ?? resolvedCurrent ?? "_No model selected_";
    const view = buildModelPickerView(pres, displayName, beId);
    try {
      await interaction.update({
        content: view.content,
        components: view.components,
      });
    } catch {
      /* ignore */
    }
  }
}
