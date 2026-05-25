/**
 * OpenAI Agents backend factory — wires the SDK into the registry.
 *
 * The backend speaks to OpenAI's Responses API via `@openai/agents`'s
 * official SDK. MCP servers are constructed as `MCPServerStdio`
 * instances at turn time + closed in `finally`.
 *
 * Returns the composed `Backend` shape directly — capability slots
 * for chat / models / sessions. No fat-optional `QueryBackend`
 * surface.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import { log } from "../../util/log.js";
import { toEventStream } from "../shared/to-event-stream.js";
import {
  composeBackend,
  type ChatBackend,
  type ModelCatalog,
  type SessionBackend,
} from "../../core/agent-runtime/capabilities.js";
import { makeBareModelRef } from "../../core/agent-runtime/model-ref.js";

import { initOpenAIAgentsAgent, getOpenAIBaseUrl } from "./init.js";
import { handleMessage as openAIAgentsHandleMessage } from "./handler.js";
import { resetState, clearChatSession } from "./state.js";
import { releaseAllBundles } from "./mcp-pool.js";
import { OPENAI_AGENTS_DEFAULT_MODEL } from "./constants.js";
import {
  resolveModel as openAIResolveModel,
  getModelInfo as openAIGetModelInfo,
  getSettingsPresentation as openAIGetSettingsPresentation,
  getProviders as openAIGetProviders,
  getProviderModels as openAIGetProviderModels,
  formatModelError as openAIFormatModelError,
  listModels as openAIListModels,
} from "./models.js";

const openAIAgentsFactory: BackendFactory = {
  id: "openai-agents",
  label: "OpenAI Agents",

  async init(config, ctx) {
    initOpenAIAgentsAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: OpenAI Agents (@openai/agents)");

    const chat: ChatBackend = {
      runChatTurn: (params) =>
        toEventStream((p) => openAIAgentsHandleMessage(p), params),
    };

    const defaultIdSync = (): string | null => {
      const baseUrl = getOpenAIBaseUrl();
      if (baseUrl && baseUrl.length > 0) return null;
      return OPENAI_AGENTS_DEFAULT_MODEL;
    };

    const models: ModelCatalog = {
      async resolveModel(query) {
        const resolution = openAIResolveModel(query);
        if (resolution.kind === "exact") {
          return {
            kind: "exact",
            model: makeBareModelRef("openai-agents", resolution.model.id),
            storedValue: resolution.storedValue,
          };
        }
        if (resolution.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            matches: resolution.matches.map((m) =>
              makeBareModelRef("openai-agents", m.id),
            ),
          };
        }
        return { kind: "missing" };
      },
      async listModels(filter) {
        const result = openAIListModels(filter.freeOnly ? "free" : "all");
        return {
          models: result.models.map((m) =>
            makeBareModelRef("openai-agents", m.id),
          ),
          total: result.total,
        };
      },
      // Only advertise a canonical default when the backend is pointed
      // at stock OpenAI. Custom baseUrls (OpenRouter, Azure, Ollama,
      // LiteLLM, etc) have no universal default — the catalog varies
      // per endpoint.
      async getDefaultModel() {
        const id = defaultIdSync();
        if (id === null) return null;
        return makeBareModelRef("openai-agents", id, "backend-default");
      },
      async getModelInfo(id) {
        const info = openAIGetModelInfo(id);
        if (!info) return undefined;
        return makeBareModelRef("openai-agents", info.id);
      },

      resolveModelInfo: (q) => Promise.resolve(openAIResolveModel(q)),
      getDefaultModelId: () => defaultIdSync(),
      getRawModelInfo: (id) => Promise.resolve(openAIGetModelInfo(id)),
      getSettingsPresentation: (m, options) =>
        openAIGetSettingsPresentation(m, options),
      getProviders: () => Promise.resolve(openAIGetProviders()),
      getProviderModels: (p, pg, ps) =>
        Promise.resolve(openAIGetProviderModels(p, pg, ps)),
      formatModelError: (q, r) => openAIFormatModelError(q, r),
      listModelsRaw: (f) => Promise.resolve(openAIListModels(f)),
    };

    const sessions: SessionBackend = {
      resetChat: (chatId) => clearChatSession(chatId),
    };

    const backend = composeBackend({
      id: "openai-agents",
      label: "OpenAI Agents",
      cacheMetrics: "read",
      chat,
      models,
      sessions,
    });

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
