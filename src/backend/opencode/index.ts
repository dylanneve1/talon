/**
 * OpenCode backend — uses the OpenCode SDK as an alternative to Claude Agent SDK.
 *
 * Re-exports from focused sub-modules:
 *   models.ts   — model catalog, search, resolution, presentation
 *   sessions.ts — message parsing, usage summaries, snapshots
 *   server.ts   — server lifecycle, MCP, session management
 *   handler.ts  — main message handler
 */

export {
  type OpenCodeModelCatalogEntry,
  type OpenCodeModelCatalog,
  type OpenCodeModelResolution,
  type ModelButton,
  getOpenCodeModelCatalog,
  getOpenCodeModelInfo,
  getOpenCodeModelSelectionValue,
  resolveOpenCodeModelInput,
  getOpenCodeQuickPickModels,
  getOpenCodeSettingsPresentation,
  renderOpenCodeModelSummary,
  renderOpenCodeModelList,
  formatOpenCodeSelectionError,
  formatOpenCodeUnavailableModel,
} from "./models.js";

export {
  summarizeOpenCodeAssistantMessages,
  getOpenCodeSessionSnapshot,
} from "./sessions.js";

export { initOpenCodeAgent, stopOpenCodeServer } from "./server.js";

export { handleMessage } from "./handler.js";
