/**
 * Kilo backend factory — wires Kilo into the registry.
 *
 * Side-effect import (`import "./factory.js"` from `bootstrap.ts`) calls
 * `registerBackend(...)` at module load, making Kilo available under
 * `config.backend === "kilo"`.
 *
 * The factory adapts Kilo's internal API to the generic `QueryBackend`
 * shape used by the dispatcher — translates `handleMessage`,
 * `runOneShotAgent`, the session-snapshot envelope, and the model
 * resolution methods.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import type { QueryBackend } from "../../core/types.js";
import { log } from "../../util/log.js";

import {
  initKiloAgent,
  stopKiloServer,
  handleMessage as kiloHandleMessage,
  runOneShotAgent as kiloRunOneShotAgent,
  getKiloSessionSnapshot,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "./index.js";

// ── Factory ────────────────────────────────────────────────────────────────

const kiloFactory: BackendFactory = {
  id: "kilo",
  label: "Kilo",

  async init(config, ctx) {
    initKiloAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Kilo");

    const backend: QueryBackend = {
      query: (params) => kiloHandleMessage(params),
      resolveModel: (q) => resolveModel(q),
      getModelInfo: (id) => getModelInfo(id),
      getSettingsPresentation: (m, prefix) =>
        getSettingsPresentation(m, prefix),
      getProviders: () => getProviders(),
      getProviderModels: (p, pg, ps) => getProviderModels(p, pg, ps),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => listModels(f),
      backendLabel: "Kilo",
      getSessionSnapshot: async (sessionId) => {
        const snap = await getKiloSessionSnapshot(sessionId);
        if (!snap) return undefined;
        return {
          inputTokens: snap.usage?.totalInputTokens,
          outputTokens: snap.usage?.totalOutputTokens,
          cacheRead: snap.usage?.totalCacheRead,
          cacheWrite: snap.usage?.totalCacheWrite,
          contextModelId: snap.assistant?.modelID,
        };
      },
      runOneShotAgent: (p) => kiloRunOneShotAgent(p),
      // Kilo runs a long-lived HTTP server — no per-query subprocesses.
      // `evictOrphanSubprocesses` is intentionally not implemented.
    };

    return {
      backend,
      cleanup: () => {
        stopKiloServer();
      },
    };
  },
};

registerBackend(kiloFactory);
