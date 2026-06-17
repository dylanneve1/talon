/**
 * OpenCode model catalog — types, resolution, formatting, and cache.
 *
 * Split by responsibility:
 *   - `types`        — raw + public catalog shapes
 *   - `catalog`      — TTL cache, raw→catalog parsing, fetch entry point
 *   - `resolve`      — query parse/match, provider-id guess, model resolver
 *   - `presentation` — quick-pick, settings buttons, summary/list, errors
 *
 * Re-exports the same public surface the old single-file module exposed.
 */

export type {
  OpenCodeModelCatalogEntry,
  OpenCodeModelCatalog,
  OpenCodeModelResolution,
  ModelButton,
} from "./types.js";
export {
  getOpenCodeModelCatalog,
  clearModelCatalogCache,
  sortCatalogModels,
} from "./catalog.js";
export {
  getOpenCodeModelInfo,
  getOpenCodeModelSelectionValue,
  resolveOpenCodeModelInput,
  guessProviderID,
  getBucketPriority,
  normalizeModelLookup,
  parseOpenCodeModelQuery,
} from "./resolve.js";
export {
  getOpenCodeQuickPickModels,
  getOpenCodeSettingsPresentation,
  renderOpenCodeModelSummary,
  renderOpenCodeModelList,
  formatOpenCodeSelectionError,
  formatOpenCodeUnavailableModel,
} from "./presentation.js";
