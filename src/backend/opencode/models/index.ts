/**
 * OpenCode model catalog — binder over the shared remote-server model-catalog
 * module (see `backend/remote-server/model-catalog/`).
 *
 * The catalog, resolution, and presentation logic is shared with Kilo (a fork
 * of OpenCode with the same wire format); this file only binds the OpenCode
 * SDK client + presentation knobs and re-exports the result under the
 * historical `OpenCode*`-prefixed names.
 *
 * Knobs: OpenCode's model picker renders through Telegram inline keyboards —
 * callback_data caps at 64 bytes and the keyboard is tight, so quick picks
 * stay at 4 and only short separator-free ids are embedded raw.
 */

import { ensureServer } from "../server.js";
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

const opencodeModels = createRemoteModelCatalogModule({
  label: "OpenCode",
  getClient: () => ensureServer(),
  maxCallbackIdLength: 48,
  allowCallbackSeparators: false,
  quickPickLimit: 4,
});

export const getOpenCodeModelCatalog = opencodeModels.getCatalog;
export const clearModelCatalogCache = opencodeModels.clearCache;
export const getOpenCodeModelInfo = opencodeModels.getModelInfo;
export const getOpenCodeQuickPickModels = opencodeModels.getQuickPickModels;
export const getOpenCodeSettingsPresentation =
  opencodeModels.getSettingsPresentation;
export const renderOpenCodeModelSummary = opencodeModels.renderModelSummary;
export const renderOpenCodeModelList = opencodeModels.renderModelList;
export const formatOpenCodeSelectionError = opencodeModels.formatSelectionError;
