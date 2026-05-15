/**
 * Kilo backend — barrel re-export.
 *
 * Uses the `@kilocode/sdk` (a fork of `@opencode-ai/sdk`) and exposes a
 * QueryBackend-compatible API. The implementation is split across
 * focused modules for readability:
 *
 *   - `models.ts`         — model catalog, search, resolution, presentation
 *   - `sessions.ts`       — message parsing, usage summaries, snapshots
 *   - `server.ts`         — server lifecycle, MCP, session management
 *   - `handler.ts`        — main message handler (with streaming + end_turn)
 *   - `one-shot.ts`       — heartbeat / dream one-shot runner
 *   - `model-provider.ts` — adapts the catalog to the QueryBackend interface
 *
 * Both Kilo-prefixed names (e.g. `initKiloAgent`) and the legacy
 * OpenCode-prefixed names (e.g. `initOpenCodeAgent`) are re-exported so
 * existing call sites in `bootstrap.ts` keep working while we migrate.
 */

// ── Models ─────────────────────────────────────────────────────────────────
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

// ── Sessions ───────────────────────────────────────────────────────────────
export {
  // Kilo-prefixed (preferred)
  summarizeKiloAssistantMessages,
  getKiloSessionSnapshot,
  getKiloTurnSummary,
  extractPartsSummary,
  extractAssistantUsage,
  rejectPendingQuestions,
  waitForAssistantReply,
  waitForPromptWithQuestionGuard,
  type KiloAssistantInfo,
  type KiloSessionSnapshot,
  // Back-compat aliases
  summarizeOpenCodeAssistantMessages,
  getOpenCodeSessionSnapshot,
  getOpenCodeTurnSummary,
  type OpenCodeAssistantInfo,
  type OpenCodeSessionSnapshot,
} from "./sessions.js";

// ── Server / lifecycle ─────────────────────────────────────────────────────
export {
  initKiloAgent,
  stopKiloServer,
  ensureServer,
  ensureSession,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  resolveProviderID,
  parseStoredKiloModelSelection,
  // Back-compat aliases
  initOpenCodeAgent,
  stopOpenCodeServer,
  parseStoredOpenCodeModelSelection,
  // Constants
  KILO_HOSTNAME,
  KILO_PORT,
  KILO_BASE_URL,
  KILO_SYSTEM_PROMPT_SUFFIX,
  TALON_MCP_SERVER_NAME,
  // Back-compat constant aliases
  OPENCODE_HOSTNAME,
  OPENCODE_PORT,
  OPENCODE_BASE_URL,
  OPENCODE_SYSTEM_PROMPT_SUFFIX,
} from "./server.js";

// ── Handler ────────────────────────────────────────────────────────────────
export { handleMessage, getActiveSession } from "./handler.js";

// ── Model provider (QueryBackend adapter) ──────────────────────────────────
export {
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  listModels,
  formatModelError,
} from "./model-provider.js";

// ── One-shot agent runner ──────────────────────────────────────────────────
export { runOneShotAgent } from "./one-shot.js";
