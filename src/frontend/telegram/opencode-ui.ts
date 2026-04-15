import {
  getOpenCodeModelCatalog,
  getOpenCodeModelInfo,
  getOpenCodeModelSelectionValue,
  getOpenCodeQuickPickModels,
  resolveOpenCodeModelInput,
  type OpenCodeModelCatalog,
  type OpenCodeModelCatalogEntry,
  type OpenCodeModelResolution,
} from "../../backend/opencode/index.js";
import { escapeHtml } from "./formatting.js";

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
};

export type OpenCodeSettingsPresentation = {
  catalog: OpenCodeModelCatalog;
  currentModel?: OpenCodeModelCatalogEntry;
  modelButtons: Array<TelegramInlineButton>;
  modelDetails: Array<string>;
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function getAvailabilityLabel(model: OpenCodeModelCatalogEntry): string {
  if (model.selectable) return model.free ? "ready · free" : "ready";
  if (model.loginRequired) return "login required";
  if (model.envRequired) return "credentials required";
  return "not connected";
}

function getShortModelButtonLabel(model: OpenCodeModelCatalogEntry): string {
  const preferred =
    model.id.length <= 20
      ? model.id
      : model.name.length <= 20
        ? model.name
        : model.id;
  return model.free ? `${preferred} ★` : preferred;
}

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) {
    return `${(contextWindow / 1_000_000).toFixed(1)}M`;
  }
  if (contextWindow >= 1_000) {
    return `${(contextWindow / 1_000).toFixed(0)}K`;
  }
  return String(contextWindow);
}

function formatModelLine(
  model: OpenCodeModelCatalogEntry,
  catalog: OpenCodeModelCatalog,
): string {
  const tags = [
    model.providerName,
    model.free ? "free" : `$${model.costInput}/${model.costOutput}`,
    `${formatContextWindow(model.contextWindow)} ctx`,
    getAvailabilityLabel(model),
  ];
  return `• <code>${escapeHtml(getOpenCodeModelSelectionValue(model, catalog))}</code> — ${escapeHtml(model.name)} (${escapeHtml(tags.join(" · "))})`;
}

function formatModelMatchPreview(
  model: OpenCodeModelCatalogEntry,
  catalog: OpenCodeModelCatalog,
): string {
  const providerLabel =
    model.providerName === model.providerID
      ? model.providerName
      : `${model.providerName} / ${model.providerID}`;
  const availability = model.selectable
    ? "ready"
    : model.loginRequired
      ? "login required"
      : model.envRequired
        ? "credentials required"
        : "not connected";
  return `<code>${escapeHtml(getOpenCodeModelSelectionValue(model, catalog))}</code> — ${escapeHtml(providerLabel)} (${escapeHtml(availability)})`;
}

export async function getOpenCodeSettingsPresentation(
  activeModel: string,
): Promise<OpenCodeSettingsPresentation> {
  const catalog = await getOpenCodeModelCatalog();
  const currentModel = await getOpenCodeModelInfo(activeModel);
  const quickPicks = getOpenCodeQuickPickModels(catalog, activeModel);

  const modelButtons: Array<TelegramInlineButton> = quickPicks.map((model) => ({
    text:
      currentModel &&
      model.id === currentModel.id &&
      model.providerID === currentModel.providerID
        ? `✓ ${getShortModelButtonLabel(model)}`
        : getShortModelButtonLabel(model),
    callback_data: `settings:model:${model.id}`,
  }));
  modelButtons.push({ text: "Reset", callback_data: "settings:model:reset" });

  const modelDetails: Array<string> = [];
  if (currentModel) {
    modelDetails.push(
      `<b>Provider:</b> ${escapeHtml(currentModel.providerName)} · ${escapeHtml(getAvailabilityLabel(currentModel))}`,
    );
    modelDetails.push(
      `<b>Context:</b> ${escapeHtml(formatContextWindow(currentModel.contextWindow))} · reasoning ${currentModel.reasoning ? "yes" : "no"} · tools ${currentModel.toolcall ? "yes" : "no"}`,
    );
  }

  modelDetails.push(
    `<b>OpenCode:</b> ${pluralize(catalog.connectedProviders.length, "provider")} connected · ${pluralize(catalog.connectedModels.length, "model")} usable`,
  );

  if (catalog.loginProviders.length > 0) {
    const loginPreview = catalog.loginProviders
      .slice(0, 4)
      .map((provider) => provider.name)
      .join(", ");
    modelDetails.push(
      `<b>Login available:</b> ${escapeHtml(loginPreview)}${catalog.loginProviders.length > 4 ? "…" : ""}`,
    );
  }

  modelDetails.push(
    `<b>Hint:</b> use <code>/model free</code>, <code>/model providers</code>, or <code>/model &lt;id&gt;</code>.`,
  );

  return {
    catalog,
    currentModel,
    modelButtons,
    modelDetails,
  };
}

export async function renderOpenCodeModelSummary(
  activeModel: string,
  defaultModel: string,
): Promise<{ text: string; quickButtons: Array<TelegramInlineButton> }> {
  const presentation = await getOpenCodeSettingsPresentation(activeModel);
  const freePreview = presentation.catalog.connectedFreeModels.slice(0, 8);
  const currentLabel = presentation.currentModel
    ? getOpenCodeModelSelectionValue(
        presentation.currentModel,
        presentation.catalog,
      )
    : activeModel;

  const lines = [
    `<b>Model:</b> <code>${escapeHtml(currentLabel)}</code>${activeModel === defaultModel ? " <i>(default)</i>" : ""}`,
    ...presentation.modelDetails,
  ];

  if (freePreview.length > 0) {
    lines.push("");
    lines.push("<b>Free now</b>");
    lines.push(
      ...freePreview.map((model) =>
        formatModelLine(model, presentation.catalog),
      ),
    );
  }

  return {
    text: lines.join("\n"),
    quickButtons: presentation.modelButtons,
  };
}

export async function renderOpenCodeModelList(
  mode: "free" | "all" | "providers",
): Promise<string> {
  const catalog = await getOpenCodeModelCatalog();

  if (mode === "providers") {
    const lines = ["<b>OpenCode Providers</b>"];
    for (const provider of catalog.providers.slice(0, 24)) {
      const detail = provider.connected
        ? "connected"
        : provider.loginRequired
          ? `login: ${provider.authMethods.join(", ")}`
          : provider.envRequired
            ? `env: ${provider.envKeys.join(", ")}`
            : provider.source;
      lines.push(
        `• <b>${escapeHtml(provider.name)}</b> (<code>${escapeHtml(provider.id)}</code>) — ${escapeHtml(detail)} · ${provider.modelCount} models`,
      );
    }
    if (catalog.providers.length > 24) {
      lines.push(`…and ${catalog.providers.length - 24} more providers`);
    }
    return lines.join("\n");
  }

  const source =
    mode === "free" ? catalog.connectedFreeModels : catalog.connectedModels;
  const title = mode === "free" ? "Connected Free Models" : "Connected Models";
  const lines = [`<b>${escapeHtml(title)}</b>`];
  for (const model of source.slice(0, 24)) {
    lines.push(formatModelLine(model, catalog));
  }
  if (source.length > 24) {
    lines.push(`…and ${source.length - 24} more models`);
  }
  return lines.join("\n");
}

export async function resolveOpenCodeModelSelection(input: string): Promise<{
  catalog: OpenCodeModelCatalog;
  resolution: OpenCodeModelResolution;
}> {
  const catalog = await getOpenCodeModelCatalog();
  return {
    catalog,
    resolution: resolveOpenCodeModelInput(input, catalog),
  };
}

export function formatOpenCodeSelectionError(
  input: string,
  resolution: OpenCodeModelResolution,
  catalog: OpenCodeModelCatalog,
): string {
  if (resolution.kind === "exact") {
    return `Model <code>${escapeHtml(getOpenCodeModelSelectionValue(resolution.model, catalog))}</code> is ready.`;
  }

  if (resolution.kind === "missing") {
    return `No OpenCode model matched <code>${escapeHtml(input)}</code>.`;
  }

  const preview = resolution.matches
    .slice(0, 6)
    .map((model: OpenCodeModelCatalogEntry) =>
      formatModelMatchPreview(model, catalog),
    )
    .join(", ");
  return `Model query <code>${escapeHtml(input)}</code> is ambiguous. Try one of: ${preview}`;
}

export function formatOpenCodeUnavailableModel(
  model: OpenCodeModelCatalogEntry,
): string {
  if (model.loginRequired) {
    return `${escapeHtml(model.providerName)} isn’t connected yet. Available login methods: ${escapeHtml(model.authMethods.join(", "))}.`;
  }
  if (model.envRequired) {
    return `${escapeHtml(model.providerName)} needs credentials/env setup before <code>${escapeHtml(model.id)}</code> can be used.`;
  }
  return `${escapeHtml(model.providerName)} isn’t connected, so <code>${escapeHtml(model.id)}</code> can’t be selected yet.`;
}
