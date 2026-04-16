/**
 * OpenCode model provider — adapts the internal catalog to the QueryBackend model interface.
 *
 * Each export matches a method on QueryBackend (resolveModel, getModelInfo, etc.).
 * Delegates to the existing catalog functions in models.ts.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
} from "../../core/types.js";

import {
  getOpenCodeModelCatalog,
  getOpenCodeModelInfo,
  getOpenCodeModelSelectionValue,
  resolveOpenCodeModelInput,
  getOpenCodeSettingsPresentation,
  formatOpenCodeSelectionError,
  formatOpenCodeUnavailableModel,
  type OpenCodeModelCatalogEntry,
  type OpenCodeModelCatalog,
  type OpenCodeModelResolution as InternalResolution,
} from "./models.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUnifiedModelInfo(
  model: OpenCodeModelCatalogEntry,
): UnifiedModelInfo {
  const info: UnifiedModelInfo = {
    id: model.id,
    displayName: model.name,
    provider: model.providerID,
    providerName: model.providerName,
    selectable: model.selectable,
    free: model.free,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
  };

  if (!model.selectable) {
    info.unavailableReason = formatOpenCodeUnavailableModel(model);
  }

  return info;
}

function toUnifiedResolution(
  internal: InternalResolution,
  catalog: OpenCodeModelCatalog,
): UnifiedModelResolution {
  switch (internal.kind) {
    case "exact":
      return {
        kind: "exact",
        model: toUnifiedModelInfo(internal.model),
        storedValue: getOpenCodeModelSelectionValue(internal.model, catalog),
      };
    case "ambiguous":
      return {
        kind: "ambiguous",
        matches: internal.matches.map(toUnifiedModelInfo),
      };
    case "missing":
      return { kind: "missing" };
  }
}

// ---------------------------------------------------------------------------
// QueryBackend model methods
// ---------------------------------------------------------------------------

export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const catalog = await getOpenCodeModelCatalog();
  const internal = resolveOpenCodeModelInput(query, catalog);
  return toUnifiedResolution(internal, catalog);
}

export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  const entry = await getOpenCodeModelInfo(id);
  return entry ? toUnifiedModelInfo(entry) : undefined;
}

export async function getSettingsPresentation(
  activeModel: string,
  callbackPrefix = "settings:model:",
): Promise<{ modelButtons: ModelButton[]; modelDetails: string[] }> {
  return getOpenCodeSettingsPresentation(activeModel, callbackPrefix);
}

export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  const catalog = await getOpenCodeModelCatalog();
  const seen = new Set<string>();
  const result: UnifiedProviderInfo[] = [];

  for (const p of catalog.connectedProviders) {
    seen.add(p.id);
    result.push({
      id: p.id,
      name: p.name,
      connected: true,
      modelCount: p.modelCount,
    });
  }

  for (const p of catalog.loginProviders) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    result.push({
      id: p.id,
      name: p.name,
      connected: false,
      modelCount: p.modelCount,
    });
  }

  return result;
}

export async function getProviderModels(
  providerId: string,
  page = 0,
  pageSize = 8,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  const catalog = await getOpenCodeModelCatalog();
  const filtered = catalog.models.filter((m) => m.providerID === providerId);
  const start = page * pageSize;
  const slice = filtered.slice(start, start + pageSize);
  return {
    models: slice.map(toUnifiedModelInfo),
    total: filtered.length,
  };
}

export async function listModels(
  filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  const catalog = await getOpenCodeModelCatalog();
  const source =
    filter === "free" ? catalog.connectedFreeModels : catalog.connectedModels;
  return {
    models: source.map(toUnifiedModelInfo),
    total: source.length,
  };
}

export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "exact") return "";

  // For "missing", delegate to the catalog error formatter with an empty matches array
  // For "ambiguous", we need to re-resolve against the internal catalog to get the
  // OpenCode-specific formatting (provider labels, selection values, etc.)
  //
  // We can't call async getOpenCodeModelCatalog here (sync function), so we build
  // a lightweight message for ambiguous and delegate missing to the existing formatter.

  if (resolution.kind === "missing") {
    return `No OpenCode model matched "${query}".`;
  }

  // ambiguous — list the matches with their provider info
  const preview = resolution.matches
    .slice(0, 6)
    .map((m) => `${m.id} (${m.providerName})`)
    .join(", ");
  return `Model query "${query}" is ambiguous. Try one of: ${preview}`;
}
