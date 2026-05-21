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
  discoverAntigravityModels,
} from "./models.js";

const antigravityFactory: BackendFactory = {
  id: "antigravity",
  label: "Antigravity",

  async init(config, ctx) {
    initAntigravityAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Antigravity (google-antigravity via Python bridge)");

    // The catalog read functions are sync (they only read the cached
    // discovery snapshot). When the picker opens for the first time
    // and discovery hasn't completed yet, the cache is empty and the
    // user sees the curated 5-model fallback — they have to switch
    // backends and come back to get the real list. Await discovery
    // inside the picker entry points so the first call blocks until
    // the live catalog is ready.
    //
    // The 5-min cache TTL means a stale picker open after init
    // re-runs discovery — we have to pass the API key explicitly
    // here, otherwise discovery falls back to the curated 5-model
    // list with `using fallback (no API key configured)`. Process
    // env isn't set at this layer; `state.config.geminiApiKey` is
    // where the live key lives.
    const cfgRecord = config as unknown as Record<string, unknown>;
    const geminiKey =
      (typeof cfgRecord.geminiApiKey === "string"
        ? (cfgRecord.geminiApiKey as string)
        : undefined) ?? process.env.GEMINI_API_KEY;
    const pythonPath =
      typeof cfgRecord.antigravityPython === "string"
        ? (cfgRecord.antigravityPython as string)
        : undefined;

    const ensureCatalog = async () => {
      try {
        await discoverAntigravityModels({
          apiKey: geminiKey,
          pythonPath,
        });
      } catch {
        // Discovery failures are already surfaced by the discovery
        // module via logs; fall back to the cache (curated fallback)
        // so the picker still works.
      }
    };

    const backend: QueryBackend = {
      query: (params) => agHandleMessage(params),
      resolveModel: async (q) => {
        await ensureCatalog();
        return resolveModel(q);
      },
      getModelInfo: async (id) => {
        await ensureCatalog();
        return getModelInfo(id);
      },
      getSettingsPresentation: async (m, options) => {
        await ensureCatalog();
        return getSettingsPresentation(m, options);
      },
      getProviders: async () => {
        await ensureCatalog();
        return getProviders();
      },
      getProviderModels: async (p, pg, ps) => {
        await ensureCatalog();
        return getProviderModels(p, pg, ps);
      },
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: async (f) => {
        await ensureCatalog();
        return listModels(f);
      },
      runOneShotAgent: (p) => agRunOneShotAgent(p),
      cacheMetrics: "read",
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
