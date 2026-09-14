/**
 * `model:nav:*` — the /model pager: page arrows, free-tier toggle, provider
 * drill, and the backend submenu. Pure navigation: re-renders the same
 * panel at the requested page without touching the chat's selected model.
 */

import {
  buildModelPickerView,
  buildBackendPickerView,
  decodeModelNav,
  MODEL_NAV_PREFIX,
  MODEL_PAGE_SIZE,
} from "../../model-picker.js";
import {
  getBackendIdForChat,
  resolveChatBackend,
  listAvailableBackends,
} from "../../../../core/engine/backend-controller/index.js";
import { resolveActiveModelForChat } from "../../../../core/models/active-model.js";
import type { ComponentContext, ComponentInteraction } from "./types.js";

export async function handleModelNav(
  interaction: ComponentInteraction,
  { config, gateway, chatId }: ComponentContext,
): Promise<void> {
  const customId = interaction.customId;
  // Backend submenu — the one nav action that isn't a re-page.
  if (customId === `${MODEL_NAV_PREFIX}:backends`) {
    const view = buildBackendPickerView(
      listAvailableBackends(config),
      getBackendIdForChat(chatId),
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

  const target = decodeModelNav(customId);
  if (!target) {
    try {
      await interaction.deferUpdate();
    } catch {
      /* ignore */
    }
    return;
  }
  const be = resolveChatBackend(chatId, gateway?.backend);
  const beId = getBackendIdForChat(chatId);
  const { model: current } = await resolveActiveModelForChat(
    chatId,
    be,
    beId,
    config,
  );
  if (!be?.models?.getSettingsPresentation) {
    try {
      await interaction.deferUpdate();
    } catch {
      /* ignore */
    }
    return;
  }
  const pres = await be.models.getSettingsPresentation(current ?? "", {
    callbackPrefix: "model:",
    navCallbackPrefix: MODEL_NAV_PREFIX,
    pageSize: MODEL_PAGE_SIZE,
    page: target.page,
    filter: target.filter,
    ...(target.provider ? { provider: target.provider } : {}),
  });
  const modelInfo = current
    ? await be.models?.getRawModelInfo?.(current)
    : undefined;
  const view = buildModelPickerView(
    pres,
    modelInfo?.displayName ?? current ?? "_No model selected_",
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
}
