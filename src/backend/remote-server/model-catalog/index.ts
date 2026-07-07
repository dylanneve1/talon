/**
 * Remote model catalog — the shared model layer for the OpenCode backend
 * family (OpenCode + its Kilo fork). Both servers expose identical
 * `/provider/list` + `/provider/auth` wire formats, so the catalog cache,
 * query resolution, presentation, and the `Backend.models` adapter live here
 * once. Each backend calls `createRemoteModelCatalogModule` with its own SDK
 * client + branding/UI knobs and re-exports the bound functions under its
 * historical names.
 */

import {
  createRemoteModelCatalogStore,
  type RemoteModelCatalogStore,
} from "./catalog.js";
import {
  createRemoteModelPresentation,
  type RemoteModelPresentation,
} from "./presentation.js";
import { getRemoteModelInfo } from "./resolve.js";
import type {
  RemoteModelCatalog,
  RemoteModelCatalogEntry,
  RemoteProviderClient,
} from "./types.js";

export type {
  ModelButton,
  RemoteAuthMethod,
  RemoteModelCatalog,
  RemoteModelCatalogEntry,
  RemoteModelResolution,
  RemoteProviderCatalogEntry,
  RemoteProviderClient,
  RemoteRawModel,
  RemoteRawProvider,
  RemoteRawProvidersData,
} from "./types.js";
export { buildModelCatalog, sortCatalogModels } from "./catalog.js";
export {
  getBucketPriority,
  getRemoteModelInfo,
  getRemoteModelSelectionValue,
  guessProviderID,
  normalizeModelLookup,
  parseRemoteModelQuery,
  resolveRemoteModelInput,
} from "./resolve.js";
export { formatRemoteUnavailableModel } from "./presentation.js";
export type { RemoteModelPresentation } from "./presentation.js";
export { createRemoteModelProvider } from "./provider.js";
export type {
  RemoteModelProvider,
  RemoteModelProviderDeps,
} from "./provider.js";
export type { RemoteModelCatalogStore } from "./catalog.js";

export interface RemoteModelCatalogModuleOptions {
  /** Human label — "OpenCode" / "Kilo" — used in headers and errors. */
  label: string;
  /** Lazy SDK client getter, typically the backend's `ensureServer`. */
  getClient: () => Promise<RemoteProviderClient>;
  /** See {@link createRemoteModelPresentation} for the UI knobs. */
  maxCallbackIdLength: number;
  allowCallbackSeparators: boolean;
  quickPickLimit: number;
  /** Catalog cache TTL override (default 60s). */
  ttlMs?: number;
}

export interface RemoteModelCatalogModule
  extends RemoteModelCatalogStore, RemoteModelPresentation {
  /** Catalog-backed model lookup (fetches through the TTL store). */
  getModelInfo(id: string): Promise<RemoteModelCatalogEntry | undefined>;
}

/** Compose store + presentation + provider for one backend. */
export function createRemoteModelCatalogModule(
  options: RemoteModelCatalogModuleOptions,
): RemoteModelCatalogModule {
  const store = createRemoteModelCatalogStore({
    getClient: options.getClient,
    ttlMs: options.ttlMs,
  });
  const getCatalog = (forceRefresh?: boolean): Promise<RemoteModelCatalog> =>
    store.getCatalog(forceRefresh);
  const presentation = createRemoteModelPresentation({
    label: options.label,
    getCatalog,
    maxCallbackIdLength: options.maxCallbackIdLength,
    allowCallbackSeparators: options.allowCallbackSeparators,
    quickPickLimit: options.quickPickLimit,
  });
  return {
    ...store,
    ...presentation,
    async getModelInfo(id) {
      return getRemoteModelInfo(await getCatalog(), id);
    },
  };
}
