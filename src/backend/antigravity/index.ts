/**
 * Antigravity backend — barrel re-export.
 *
 * Wraps the `google-antigravity` Python SDK via a long-lived bridge
 * subprocess. Each active chat owns its own bridge so per-chat MCP
 * server config (Talon's frontend-tools server is chat-scoped) stays
 * isolated.
 *
 * Modules:
 *   - `constants.ts`     — system-prompt suffix, default model, paths.
 *   - `state.ts`         — per-process state container.
 *   - `python-bridge.ts` — subprocess lifecycle + JSON event protocol.
 *   - `mcp-config.ts`    — Talon MCP plugins → bridge mcp_servers list.
 *   - `models.ts`        — Gemini model catalog.
 *   - `init.ts`          — backend init + lazy bridge construction.
 *   - `handler.ts`       — main message handler.
 *   - `one-shot.ts`      — heartbeat / dream runner.
 *   - `factory.ts`       — registry registration.
 */

export {
  ANTIGRAVITY_SYSTEM_PROMPT_SUFFIX,
  ANTIGRAVITY_DEFAULT_MODEL,
  ANTIGRAVITY_DEFAULT_VENV_PATH,
  ANTIGRAVITY_TURN_TIMEOUT_MS,
} from "./constants.js";

export { initAntigravityAgent, ensureBridge } from "./init.js";

export { handleMessage, getActiveAbort } from "./handler.js";

export { runOneShotAgent } from "./one-shot.js";

export {
  buildAntigravityMcpServers,
  type AntigravityMcpServer,
} from "./mcp-config.js";

export {
  AntigravityBridge,
  type BridgeConfig,
  type BridgeSpawnOptions,
  type BridgeTurnResult,
  type BridgeUsage,
  type ChatOptions,
} from "./python-bridge.js";

export {
  ANTIGRAVITY_MODELS,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "./models.js";
