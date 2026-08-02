/**
 * Kilo backend — barrel re-export.
 *
 * Uses the `@kilocode/sdk` (a fork of `@opencode-ai/sdk`) and exposes a
 * Backend-compatible API. The implementation is split across
 * focused modules for readability:
 *
 *   - `models.ts`         — model catalog, search, resolution, presentation
 *   - `sessions.ts`       — message parsing, usage summaries, snapshots
 *   - `server.ts`         — server lifecycle, MCP, session management
 *   - `events.ts`         — Kilo-side configurator over shared SSE events
 *   - `handler.ts`        — main message handler (streaming, end_turn,
 *                           delivery routing)
 *   - `one-shot.ts`       — heartbeat / dream one-shot runner
 *   - `model-provider.ts` — adapts the catalog to the Backend interface
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
  getOpenCodeModelSelectionValue,
  resolveOpenCodeModelInput,
  getOpenCodeQuickPickModels,
  formatOpenCodeSelectionError,
} from "./models/index.js";

// ── Sessions ───────────────────────────────────────────────────────────────
export {
  summarizeKiloAssistantMessages,
  getKiloSessionSnapshot,
  type KiloAssistantInfo,
  type KiloSessionSnapshot,
} from "./sessions.js";

// ── Server / lifecycle ─────────────────────────────────────────────────────
export {
  initKiloAgent,
  stopKiloServer,
  refreshPluginMcpServers,
  updateSystemPrompt,
  warmSession,
} from "./server.js";

// ── Handler ────────────────────────────────────────────────────────────────
export { handleMessage } from "./handler/index.js";

// ── Model provider (Backend adapter) ──────────────────────────────────
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
