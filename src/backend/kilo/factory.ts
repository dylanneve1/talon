/**
 * Kilo backend factory — wires Kilo into the registry.
 *
 * Side-effect import (`import "./factory.js"` from `bootstrap.ts`) calls
 * `registerBackend(...)` at module load, making Kilo available under
 * `config.backend === "kilo"`.
 *
 * Returns the composed `Backend` shape directly — capability slots
 * for chat / background / models / usage. No fat-optional
 * `QueryBackend` surface.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import { log } from "../../util/log.js";
import { toEventStream } from "../shared/to-event-stream.js";
import {
  composeBackend,
  type ChatBackend,
  type BackgroundRunner,
  type ModelCatalog,
  type UsageTelemetry,
} from "../../core/agent-runtime/capabilities.js";
import { makeBareModelRef } from "../../core/agent-runtime/model-ref.js";

import {
  initKiloAgent,
  stopKiloServer,
  handleMessage as kiloHandleMessage,
  runOneShotAgent as kiloRunOneShotAgent,
  getKiloSessionSnapshot,
  resolveModel as kiloResolveModel,
  getModelInfo as kiloGetModelInfo,
  getSettingsPresentation as kiloGetSettingsPresentation,
  getProviders as kiloGetProviders,
  getProviderModels as kiloGetProviderModels,
  formatModelError as kiloFormatModelError,
  listModels as kiloListModels,
} from "./index.js";

const kiloFactory: BackendFactory = {
  id: "kilo",
  label: "Kilo",

  async init(config, ctx) {
    initKiloAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Kilo (@kilocode/sdk)");

    const chat: ChatBackend = {
      runChatTurn: (params) =>
        toEventStream((p) => kiloHandleMessage(p), params),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => kiloRunOneShotAgent(p),
      // Kilo runs a long-lived HTTP server — no per-query subprocesses.
      // `evictOrphanSubprocesses` is intentionally not implemented.
    };

    const models: ModelCatalog = {
      async resolveModel(query) {
        const resolution = await kiloResolveModel(query);
        if (resolution.kind === "exact") {
          return {
            kind: "exact",
            model: makeBareModelRef("kilo", resolution.model.id),
            storedValue: resolution.storedValue,
          };
        }
        if (resolution.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            matches: resolution.matches.map((m) =>
              makeBareModelRef("kilo", m.id),
            ),
          };
        }
        return { kind: "missing" };
      },
      async listModels(filter) {
        const result = await kiloListModels(filter.freeOnly ? "free" : "all");
        return {
          models: result.models.map((m) => makeBareModelRef("kilo", m.id)),
          total: result.total,
        };
      },
      // Catalog-driven backend with no canonical default — fall through
      // to `config.backendDefaults.kilo`.
      getDefaultModel: () => Promise.resolve(null),
      async getModelInfo(id) {
        const info = await kiloGetModelInfo(id);
        if (!info) return undefined;
        return makeBareModelRef("kilo", info.id);
      },

      resolveModelInfo: (q) => kiloResolveModel(q),
      getDefaultModelId: () => undefined,
      getRawModelInfo: (id) => kiloGetModelInfo(id),
      getSettingsPresentation: async (m, options) => {
        // Kilo's existing helper returns legacy `{modelButtons,
        // modelDetails}`. Wrap into the new `ModelPickerResult` shape;
        // Kilo doesn't expose pagination or a free-tier filter so the
        // result is always page 1 of 1 with filter "all".
        const legacy = await kiloGetSettingsPresentation(
          m,
          options?.callbackPrefix,
        );
        return {
          ...legacy,
          view: "models" as const,
          page: 1,
          totalPages: 1,
          filter: "all" as const,
          freeCount: 0,
          totalCount: legacy.modelButtons.length,
        };
      },
      getProviders: () => kiloGetProviders(),
      getProviderModels: (p, pg, ps) => kiloGetProviderModels(p, pg, ps),
      formatModelError: (q, r) => kiloFormatModelError(q, r),
      listModelsRaw: (f) => kiloListModels(f),
    };

    const usage: UsageTelemetry = {
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
    };

    const backend = composeBackend({
      id: "kilo",
      label: "Kilo",
      cacheMetrics: "readwrite",
      chat,
      background,
      models,
      usage,
    });

    return {
      backend,
      cleanup: () => {
        stopKiloServer();
      },
    };
  },
};

registerBackend(kiloFactory);
