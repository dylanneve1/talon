/**
 * Antigravity backend factory — wires `google-antigravity` (via Python
 * bridge subprocess) into Talon's backend registry.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import type { QueryBackend } from "../../core/types.js";
import { log } from "../../util/log.js";

import { initAntigravityAgent } from "./init.js";
import { handleMessage as agHandleMessage } from "./handler.js";
import { runOneShotAgent as agRunOneShotAgent } from "./one-shot.js";
import { resetState as resetAntigravityState } from "./state.js";
import {
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "./models.js";

const antigravityFactory: BackendFactory = {
  id: "antigravity",
  label: "Antigravity",

  async init(config, ctx) {
    initAntigravityAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Antigravity (google-antigravity via Python bridge)");

    const backend: QueryBackend = {
      query: (params) => agHandleMessage(params),
      resolveModel: (q) => Promise.resolve(resolveModel(q)),
      getModelInfo: (id) => Promise.resolve(getModelInfo(id)),
      getSettingsPresentation: (m, options) =>
        Promise.resolve(getSettingsPresentation(m, options)),
      getProviders: () => Promise.resolve(getProviders()),
      getProviderModels: (p, pg, ps) =>
        Promise.resolve(getProviderModels(p, pg, ps)),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => Promise.resolve(listModels(f)),
      runOneShotAgent: (p) => agRunOneShotAgent(p),
      backendLabel: "Antigravity",
    };

    return {
      backend,
      cleanup: async () => {
        await resetAntigravityState();
        log("bot", "Antigravity backend cleaned up");
      },
    };
  },
};

registerBackend(antigravityFactory);
