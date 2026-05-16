/**
 * OpenCode backend factory — wires OpenCode into the registry.
 *
 * Mirrors the Kilo factory in structure. OpenCode and Kilo share the
 * same protocol shape (Kilo is a fork) so the adapter logic is nearly
 * identical — only the SDK import and a few constant names differ.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import type { QueryBackend } from "../../core/types.js";
import { log } from "../../util/log.js";

import {
  initOpenCodeAgent,
  stopOpenCodeServer,
  handleMessage as ocHandleMessage,
  runOneShotAgent as ocRunOneShotAgent,
  getOpenCodeSessionSnapshot,
  resolveModel,
  getModelInfo,
  getSettingsPresentation,
  getProviders,
  getProviderModels,
  formatModelError,
  listModels,
} from "./index.js";

// ── Factory ────────────────────────────────────────────────────────────────

const opencodeFactory: BackendFactory = {
  id: "opencode",
  label: "OpenCode",

  async init(config, ctx) {
    initOpenCodeAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: OpenCode (@opencode-ai/sdk)");

    const backend: QueryBackend = {
      query: (params) => ocHandleMessage(params),
      resolveModel: (q) => resolveModel(q),
      getModelInfo: (id) => getModelInfo(id),
      getSettingsPresentation: (m, prefix) =>
        getSettingsPresentation(m, prefix),
      getProviders: () => getProviders(),
      getProviderModels: (p, pg, ps) => getProviderModels(p, pg, ps),
      formatModelError: (q, r) => formatModelError(q, r),
      listModels: (f) => listModels(f),
      backendLabel: "OpenCode",
      getSessionSnapshot: async (sessionId) => {
        const snap = await getOpenCodeSessionSnapshot(sessionId);
        if (!snap) return undefined;
        return {
          inputTokens: snap.usage?.totalInputTokens,
          outputTokens: snap.usage?.totalOutputTokens,
          cacheRead: snap.usage?.totalCacheRead,
          cacheWrite: snap.usage?.totalCacheWrite,
          contextModelId: snap.assistant?.modelID,
        };
      },
      runOneShotAgent: (p) => ocRunOneShotAgent(p),
    };

    return {
      backend,
      cleanup: () => {
        stopOpenCodeServer();
      },
    };
  },
};

registerBackend(opencodeFactory);
