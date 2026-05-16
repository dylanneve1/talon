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

import { initOpenAIAgentsAgent } from "./init.js";
import { handleMessage as openAIAgentsHandleMessage } from "./handler.js";
import { resetState } from "./state.js";
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
      resolveModel: (q) => Promise.resolve(resolveModel(q)),
      getModelInfo: (id) => Promise.resolve(getModelInfo(id)),
      getSettingsPresentation: (m, prefix) =>
        Promise.resolve(getSettingsPresentation(m, prefix)),
      getProviders: () => Promise.resolve(getProviders()),
      getProviderModels: (p, pg, ps) =>
        Promise.resolve(getProviderModels(p, pg, ps)),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => Promise.resolve(listModels(f)),
      backendLabel: "OpenAI Agents",
    };

    return {
      backend,
      // Cleanup: drop the cached state. MCP servers spawned by
      // individual handle-message calls own their own lifecycle and
      // are closed in their own `finally` blocks — no global state to
      // shut down here.
      cleanup: () => {
        resetState();
        log("bot", "OpenAI Agents backend cleaned up");
      },
    };
  },
};

registerBackend(openAIAgentsFactory);
