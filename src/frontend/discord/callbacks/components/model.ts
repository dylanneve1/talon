/**
 * `model:*` — the /model panel, three ids under one prefix:
 *
 *   model:select           (select menu → model-select.ts)
 *   model:nav:*            (pager buttons → model-nav.ts)
 *   model:backend-select   (select menu → backend-select.ts)
 */

import { MODEL_NAV_PREFIX } from "../../model-picker.js";
import { handleBackendSelect } from "./backend-select.js";
import { handleModelNav } from "./model-nav.js";
import { handleModelSelect } from "./model-select.js";
import type { ComponentContext, ComponentInteraction } from "./types.js";

export async function handleModelComponent(
  interaction: ComponentInteraction,
  context: ComponentContext,
): Promise<boolean> {
  const customId = interaction.customId;
  if (customId === "model:select" && interaction.isStringSelectMenu()) {
    await handleModelSelect(interaction, context);
    return true;
  }
  if (customId.startsWith(`${MODEL_NAV_PREFIX}:`)) {
    await handleModelNav(interaction, context);
    return true;
  }
  if (customId === "model:backend-select" && interaction.isStringSelectMenu()) {
    await handleBackendSelect(interaction, context);
    return true;
  }
  return false;
}
