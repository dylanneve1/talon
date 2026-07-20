/**
 * Kilo model catalog — binder over the shared remote-server model-catalog
 * module (see `backend/remote-server/model-catalog/`).
 *
 * Kilo's provider-bucket API is forked from OpenCode's, so the catalog,
 * resolution, and presentation logic is the shared implementation; this file
 * only binds the Kilo SDK client + presentation knobs and re-exports the
 * result under the historical `OpenCode*`-prefixed names (retained on
 * purpose — the names match the wire shape the upstream actually emits).
 *
 * Knobs: Kilo's model picker renders through Discord StringSelectMenus,
 * which allow 25 options and values up to 100 chars with any characters —
 * Kilo ids routinely contain "/" and ":" (e.g. "inclusionai/ling-2.6-1t:free").
 */

import { ensureServer, onServerStop } from "../server.js";
import { createRemoteModelCatalogModule } from "../../remote-server/model-catalog/index.js";

export type {
  RemoteModelCatalogEntry as OpenCodeModelCatalogEntry,
  RemoteModelCatalog as OpenCodeModelCatalog,
  RemoteModelResolution as OpenCodeModelResolution,
  ModelButton,
} from "../../remote-server/model-catalog/index.js";
export {
  sortCatalogModels,
  getRemoteModelSelectionValue as getOpenCodeModelSelectionValue,
  resolveRemoteModelInput as resolveOpenCodeModelInput,
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseRemoteModelQuery as parseOpenCodeModelQuery,
  formatRemoteUnavailableModel as formatOpenCodeUnavailableModel,
} from "../../remote-server/model-catalog/index.js";

const kiloModels = createRemoteModelCatalogModule({
  label: "Kilo",
  getClient: () => ensureServer(),
  maxCallbackIdLength: 90,
  allowCallbackSeparators: true,
  quickPickLimit: 24,
});

// A stopped server invalidates the catalog it served.
onServerStop(kiloModels.clearCache);

export const getOpenCodeModelCatalog = kiloModels.getCatalog;
export const clearModelCatalogCache = kiloModels.clearCache;
export const getOpenCodeModelInfo = kiloModels.getModelInfo;
export const getOpenCodeQuickPickModels = kiloModels.getQuickPickModels;
export const getOpenCodeSettingsPresentation =
  kiloModels.getSettingsPresentation;
export const renderOpenCodeModelSummary = kiloModels.renderModelSummary;
export const renderOpenCodeModelList = kiloModels.renderModelList;
export const formatOpenCodeSelectionError = kiloModels.formatSelectionError;
