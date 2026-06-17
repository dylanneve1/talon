/**
 * Kilo model presentation — quick-pick selection, settings-panel buttons,
 * summary/list rendering, and selection-error formatting.
 */

import type {
  ModelButton,
  OpenCodeModelCatalog,
  OpenCodeModelCatalogEntry,
  OpenCodeModelResolution,
} from "./types.js";
import { getOpenCodeModelCatalog } from "./catalog.js";
import {
  getOpenCodeModelInfo,
  getOpenCodeModelSelectionValue,
  resolveOpenCodeModelInput,
} from "./resolve.js";

function isCallbackSafeModelID(modelID: string): boolean {
  // Discord StringSelectMenu values cap at 100 chars and accept any chars.
  // Kilo model IDs use "/" and ":" routinely (e.g. "inclusionai/ling-2.6-1t:free"),
  // so we only enforce a length budget that leaves room for the "model:" prefix.
  return modelID.length <= 90;
}

export function getOpenCodeQuickPickModels(
  catalog: OpenCodeModelCatalog,
  currentModelID?: string,
): Array<OpenCodeModelCatalogEntry> {
  const picks: Array<OpenCodeModelCatalogEntry> = [];
  const seen = new Set<string>();

  const tryAdd = (model: OpenCodeModelCatalogEntry | undefined) => {
    if (!model || seen.has(model.id) || !isCallbackSafeModelID(model.id))
      return;
    picks.push(model);
    seen.add(model.id);
  };

  if (currentModelID) {
    const currentModel = resolveOpenCodeModelInput(currentModelID, catalog);
    if (currentModel.kind === "exact") {
      tryAdd(currentModel.model);
    } else if (currentModel.kind === "ambiguous") {
      tryAdd(currentModel.matches[0]);
    }
  }

  // Discord StringSelectMenu allows up to 25 options; we leave one slot for
  // "Reset" and keep the rest for free + connected models.
  const PICK_BUDGET = 24;

  for (const model of catalog.connectedFreeModels) {
    tryAdd(model);
    if (picks.length >= PICK_BUDGET) break;
  }

  if (picks.length < PICK_BUDGET) {
    for (const model of catalog.connectedModels) {
      tryAdd(model);
      if (picks.length >= PICK_BUDGET) break;
    }
  }

  return picks;
}

function getAvailabilityLabel(model: OpenCodeModelCatalogEntry) {
  if (model.selectable) return model.free ? "ready · free" : "ready";
  if (model.loginRequired) return "login required";
  if (model.envRequired) return "credentials required";
  return "not connected";
}

function formatCtxWindow(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export async function getOpenCodeSettingsPresentation(
  activeModel: string,
  callbackPrefix = "settings:model:",
): Promise<{ modelButtons: Array<ModelButton>; modelDetails: Array<string> }> {
  const catalog = await getOpenCodeModelCatalog();
  const current = await getOpenCodeModelInfo(activeModel);
  const picks = getOpenCodeQuickPickModels(catalog, activeModel);

  const modelButtons: Array<ModelButton> = picks.map((m) => {
    const label =
      m.id.length <= 20 ? m.id : m.name.length <= 20 ? m.name : m.id;
    const txt = m.free ? `${label} ★` : label;
    const sel =
      current && m.id === current.id && m.providerID === current.providerID;
    return {
      text: sel ? `✓ ${txt}` : txt,
      callback_data: `${callbackPrefix}${m.id}`,
    };
  });
  modelButtons.push({ text: "Reset", callback_data: `${callbackPrefix}reset` });

  const details: Array<string> = [];
  if (current) {
    details.push(
      `Provider: ${current.providerName} · ${getAvailabilityLabel(current)}`,
    );
    details.push(
      `Context: ${formatCtxWindow(current.contextWindow)} · reasoning ${current.reasoning ? "yes" : "no"} · tools ${current.toolcall ? "yes" : "no"}`,
    );
  }
  const np = catalog.connectedProviders.length;
  const nm = catalog.connectedModels.length;
  details.push(
    `Kilo: ${np} provider${np === 1 ? "" : "s"} connected · ${nm} model${nm === 1 ? "" : "s"} usable`,
  );
  if (catalog.loginProviders.length > 0) {
    const preview = catalog.loginProviders
      .slice(0, 4)
      .map((p) => p.name)
      .join(", ");
    details.push(
      `Login available: ${preview}${catalog.loginProviders.length > 4 ? "…" : ""}`,
    );
  }
  details.push("Hint: use /model <name> to switch.");
  return { modelButtons, modelDetails: details };
}

export async function renderOpenCodeModelSummary(
  activeModel: string,
  defaultModel: string,
): Promise<{ text: string; quickButtons: Array<ModelButton> }> {
  const { modelButtons, modelDetails } =
    await getOpenCodeSettingsPresentation(activeModel);
  const catalog = await getOpenCodeModelCatalog();
  const current = await getOpenCodeModelInfo(activeModel);
  const currentLabel = current
    ? getOpenCodeModelSelectionValue(current, catalog)
    : activeModel;
  const freePreview = catalog.connectedFreeModels.slice(0, 8);

  const lines = [
    `Model: ${currentLabel}${activeModel === defaultModel ? " (default)" : ""}`,
    ...modelDetails,
  ];
  if (freePreview.length > 0) {
    lines.push("", "Free now");
    for (const m of freePreview) {
      const tags = [
        m.providerName,
        m.free ? "free" : `$${m.costInput}/${m.costOutput}`,
        `${formatCtxWindow(m.contextWindow)} ctx`,
        getAvailabilityLabel(m),
      ];
      lines.push(
        `• ${getOpenCodeModelSelectionValue(m, catalog)} — ${m.name} (${tags.join(" · ")})`,
      );
    }
  }
  return { text: lines.join("\n"), quickButtons: modelButtons };
}

export async function renderOpenCodeModelList(
  mode: "free" | "all" | "providers",
): Promise<string> {
  const catalog = await getOpenCodeModelCatalog();
  if (mode === "providers") {
    const lines = ["Kilo Providers"];
    for (const p of catalog.providers.slice(0, 24)) {
      const detail = p.connected
        ? "connected"
        : p.loginRequired
          ? `login: ${p.authMethods.join(", ")}`
          : p.envRequired
            ? `env: ${p.envKeys.join(", ")}`
            : p.source;
      lines.push(`• ${p.name} (${p.id}) — ${detail} · ${p.modelCount} models`);
    }
    if (catalog.providers.length > 24)
      lines.push(`…and ${catalog.providers.length - 24} more`);
    return lines.join("\n");
  }
  const source =
    mode === "free" ? catalog.connectedFreeModels : catalog.connectedModels;
  const title = mode === "free" ? "Connected Free Models" : "Connected Models";
  const lines = [title];
  for (const m of source.slice(0, 24)) {
    const tags = [
      m.providerName,
      m.free ? "free" : `$${m.costInput}/${m.costOutput}`,
      `${formatCtxWindow(m.contextWindow)} ctx`,
      getAvailabilityLabel(m),
    ];
    lines.push(
      `• ${getOpenCodeModelSelectionValue(m, catalog)} — ${m.name} (${tags.join(" · ")})`,
    );
  }
  if (source.length > 24) lines.push(`…and ${source.length - 24} more`);
  return lines.join("\n");
}

export function formatOpenCodeSelectionError(
  input: string,
  resolution: Exclude<OpenCodeModelResolution, { kind: "exact" }>,
  catalog: OpenCodeModelCatalog,
) {
  if (resolution.kind === "missing")
    return `No OpenCode model matched "${input}".`;
  const preview = resolution.matches
    .slice(0, 6)
    .map((m) => {
      const provider =
        m.providerName === m.providerID
          ? m.providerName
          : `${m.providerName} / ${m.providerID}`;
      return `${getOpenCodeModelSelectionValue(m, catalog)} — ${provider} (${getAvailabilityLabel(m)})`;
    })
    .join(", ");
  return `Model query "${input}" is ambiguous. Try one of: ${preview}`;
}

export function formatOpenCodeUnavailableModel(
  model: OpenCodeModelCatalogEntry,
) {
  if (model.loginRequired)
    return `${model.providerName} isn't connected yet. Login methods: ${model.authMethods.join(", ")}.`;
  if (model.envRequired)
    return `${model.providerName} needs credentials/env setup before ${model.id} can be used.`;
  return `${model.providerName} isn't connected, so ${model.id} can't be selected yet.`;
}
