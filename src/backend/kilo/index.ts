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
 *   - `events.ts`         — Kilo-side configurator over shared SSE events
 *   - `handler.ts`        — main message handler (streaming, end_turn,
 *                           delivery routing)
 *   - `one-shot.ts`       — heartbeat / dream one-shot runner
 *   - `model-provider.ts` — adapts the catalog to the QueryBackend interface
 *
 * Note: internal `OpenCode*` type names in `models.ts` (e.g.
 * `OpenCodeModelCatalogEntry`) are retained on purpose — Kilo's
 * provider-bucket API is forked from OpenCode's wire shape, so the
 * names match what the upstream actually emits.
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
  summarizeKiloAssistantMessages,
  getKiloSessionSnapshot,
  getKiloTurnSummary,
  extractPartsSummary,
  extractAssistantUsage,
  rejectPendingQuestions,
  type KiloAssistantInfo,
  type KiloSessionSnapshot,
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
  KILO_HOSTNAME,
  KILO_PORT,
  KILO_BASE_URL,
  KILO_SYSTEM_PROMPT_SUFFIX,
  TALON_MCP_SERVER_NAME,
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
