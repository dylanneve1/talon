/**
 * OpenAI Agents backend — barrel.
 *
 * Importing this module registers the backend with the registry via
 * `factory.ts`'s side-effect import. Most callers should NOT need to
 * reach in here — the bootstrap layer picks the active backend by id.
 */

import "./factory.js";

export { initOpenAIAgentsAgent, getOpenAIApiKey } from "./init.js";
export { handleMessage, getActiveAbort } from "./handler.js";
export { resetState, getState } from "./state.js";
export {
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "./models.js";
export {
  OPENAI_AGENTS_SYSTEM_PROMPT_SUFFIX,
  OPENAI_AGENTS_DEFAULT_MODEL,
  OPENAI_AGENTS_MAX_TURNS,
  OPENAI_AGENTS_AGENT_NAME,
} from "./constants.js";
export { buildOpenAIAgentsMcpServers } from "./mcp.js";
export type { OpenAIAgentsMcpBundle } from "./mcp.js";
