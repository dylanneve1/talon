/**
 * Remote model provider — adapts the internal catalog to the `Backend.models`
 * interface (resolveModel, getModelInfo, getProviders, …).
 *
 * One implementation for the whole OpenCode family. The catalog surface is
 * injected (rather than captured from the module factory) so each backend's
 * `model-provider.ts` binds its own `models/index.js` — which also keeps that
 * module the single seam tests mock.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
} from "../../../core/types.js";
import type {
  RemoteModelCatalog,
  RemoteModelCatalogEntry,
  RemoteModelResolution,
} from "./types.js";
import type {
  RemotePickerOptions,
  RemotePickerResult,
} from "./presentation.js";

export interface RemoteModelProviderDeps {
  /** Human label — "OpenCode" / "Kilo" — used in error strings. */
  label: string;
  getCatalog(forceRefresh?: boolean): Promise<RemoteModelCatalog>;
  getModelInfo(id: string): Promise<RemoteModelCatalogEntry | undefined>;
  resolveModelInput(
    query: string,
    catalog: RemoteModelCatalog,
  ): RemoteModelResolution;
  getSelectionValue(
    model: RemoteModelCatalogEntry,
    catalog: RemoteModelCatalog,
  ): string;
  formatUnavailableModel(model: RemoteModelCatalogEntry): string;
  getSettingsPresentation(
    activeModel: string,
    options?: RemotePickerOptions,
  ): Promise<RemotePickerResult>;
}

export interface RemoteModelProvider {
  resolveModel(query: string): Promise<UnifiedModelResolution>;
  getModelInfo(id: string): Promise<UnifiedModelInfo | undefined>;
  getSettingsPresentation(
    activeModel: string,
    options?: RemotePickerOptions,
  ): Promise<RemotePickerResult>;
  getProviders(): Promise<UnifiedProviderInfo[]>;
  getProviderModels(
    providerId: string,
    page?: number,
    pageSize?: number,
  ): Promise<{ models: UnifiedModelInfo[]; total: number }>;
  listModels(
    filter?: "free" | "all",
  ): Promise<{ models: UnifiedModelInfo[]; total: number }>;
  formatModelError(query: string, resolution: UnifiedModelResolution): string;
}

export function createRemoteModelProvider(
  deps: RemoteModelProviderDeps,
): RemoteModelProvider {
  function toUnifiedModelInfo(
    model: RemoteModelCatalogEntry,
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
      supportedReasoningLevels: model.supportedReasoningLevels,
      defaultReasoningLevel: model.defaultReasoningLevel,
    };

    if (!model.selectable) {
      info.unavailableReason = deps.formatUnavailableModel(model);
    }

    return info;
  }

  function toUnifiedResolution(
    internal: RemoteModelResolution,
    catalog: RemoteModelCatalog,
  ): UnifiedModelResolution {
    switch (internal.kind) {
      case "exact":
        return {
          kind: "exact",
          model: toUnifiedModelInfo(internal.model),
          storedValue: deps.getSelectionValue(internal.model, catalog),
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

  return {
    async resolveModel(query) {
      const catalog = await deps.getCatalog();
      const internal = deps.resolveModelInput(query, catalog);
      return toUnifiedResolution(internal, catalog);
    },

    async getModelInfo(id) {
      const entry = await deps.getModelInfo(id);
      return entry ? toUnifiedModelInfo(entry) : undefined;
    },

    getSettingsPresentation(activeModel, options) {
      return deps.getSettingsPresentation(activeModel, options);
    },

    async getProviders() {
      const catalog = await deps.getCatalog();
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
    },

    // Page numbering is 1-based — the shared convention for
    // `Backend.models.getProviderModels` (see core/agent-runtime/capabilities.ts).
    async getProviderModels(providerId, page = 1, pageSize = 8) {
      const catalog = await deps.getCatalog();
      const filtered = catalog.models.filter(
        (m) => m.providerID === providerId,
      );
      const start = (page - 1) * pageSize;
      const slice = filtered.slice(start, start + pageSize);
      return {
        models: slice.map(toUnifiedModelInfo),
        total: filtered.length,
      };
    },

    async listModels(filter) {
      const catalog = await deps.getCatalog();
      const source =
        filter === "free"
          ? catalog.connectedFreeModels
          : catalog.connectedModels;
      return {
        models: source.map(toUnifiedModelInfo),
        total: source.length,
      };
    },

    formatModelError(query, resolution) {
      if (resolution.kind === "exact") return "";
      if (resolution.kind === "missing") {
        return `No ${deps.label} model matched "${query}".`;
      }
      const preview = resolution.matches
        .slice(0, 6)
        .map((m) => `${m.id} (${m.providerName})`)
        .join(", ");
      return `Model query "${query}" is ambiguous. Try one of: ${preview}`;
    },
  };
}
