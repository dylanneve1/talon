/**
 * OpenAI Agents backend factory — wires the SDK into the registry.
 *
 * The backend speaks to OpenAI's Responses API via `@openai/agents`'s
 * official SDK. MCP servers are constructed as `MCPServerStdio`
 * instances at turn time + closed in `finally`.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import type { QueryBackend } from "../../core/types.js";
import { log } from "../../util/log.js";

import { initOpenAIAgentsAgent, getOpenAIBaseUrl } from "./init.js";
import { handleMessage as openAIAgentsHandleMessage } from "./handler.js";
import { resetState, clearChatSession } from "./state.js";
import { releaseAllBundles } from "./mcp-pool.js";
import { OPENAI_AGENTS_DEFAULT_MODEL } from "./constants.js";
import {
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "./models.js";

const openAIAgentsFactory: BackendFactory = {
  id: "openai-agents",
  label: "OpenAI Agents",

  async init(config, ctx) {
    initOpenAIAgentsAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: OpenAI Agents (@openai/agents)");

    const backend: QueryBackend = {
      query: (params) => openAIAgentsHandleMessage(params),
      resetChat: (chatId) => clearChatSession(chatId),
      resolveModel: (q) => Promise.resolve(resolveModel(q)),
      // Only advertise a canonical default when the backend is pointed
      // at stock OpenAI. Custom baseUrls (OpenRouter, Azure, Ollama,
      // LiteLLM, etc) have no universal default — the catalog varies
      // per endpoint. Returning `null` makes the resolver fall through
      // to `config.backendDefaults["openai-agents"]` (operator override)
      // and finally to "no model selected" if neither is configured.
      getDefaultModel: () => {
        const baseUrl = getOpenAIBaseUrl();
        if (baseUrl && baseUrl.length > 0) return null;
        return OPENAI_AGENTS_DEFAULT_MODEL;
      },
      getModelInfo: (id) => Promise.resolve(getModelInfo(id)),
      getSettingsPresentation: (m, options) =>
        getSettingsPresentation(m, options),
      getProviders: () => Promise.resolve(getProviders()),
      getProviderModels: (p, pg, ps) =>
        Promise.resolve(getProviderModels(p, pg, ps)),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => Promise.resolve(listModels(f)),
      cacheMetrics: "read",
      backendLabel: "OpenAI Agents",
    };

    return {
      backend,
      // Cleanup: close every per-chat MCP bundle in the pool so the
      // ~15 plugin subprocesses per active chat don't outlive the
      // backend itself, then drop the cached state.
      cleanup: async () => {
        await releaseAllBundles();
        resetState();
        log("bot", "OpenAI Agents backend cleaned up");
      },
    };
  },
};

registerBackend(openAIAgentsFactory);
