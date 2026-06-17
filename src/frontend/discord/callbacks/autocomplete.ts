/**
 * Autocomplete for `/model name:` — cached model-list lookup with a 30s TTL
 * so we don't hit the backend on every keystroke.
 */

import type { AutocompleteInteraction } from "discord.js";
import type { Gateway } from "../../../core/engine/gateway.js";
import { safeSlice } from "../formatting.js";

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
  if (!be?.models?.getSettingsPresentation) return [];
  const pres = await be.models?.getSettingsPresentation("", {
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
