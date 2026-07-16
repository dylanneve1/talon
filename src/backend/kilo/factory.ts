/**
 * Kilo backend factory — wires Kilo into the registry.
 *
 * Side-effect import (`import "./factory.js"` from `bootstrap.ts`) calls
 * `registerBackend(...)` at module load, making Kilo available under
 * `config.backend === "kilo"`.
 *
 * Returns a composed `Backend` with capability slots for chat,
 * background, models, and usage.
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import type { BackendFactory } from "../../core/agent-runtime/backend-registry.js";
import { log } from "../../util/log.js";
import { handlerToEvents } from "../shared/handler-to-events.js";
import { interruptChatTurn } from "../shared/turn-interrupt.js";
import {
  composeBackend,
  type ChatBackend,
  type BackgroundRunner,
  type ModelCatalog,
  type UsageTelemetry,
} from "../../core/agent-runtime/capabilities.js";

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
        handlerToEvents((p) => kiloHandleMessage(p), params),
      interruptChatTurn: (chatId) => interruptChatTurn(chatId),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => kiloRunOneShotAgent(p),
      // Kilo runs a long-lived HTTP server — no per-query subprocesses.
      // `evictOrphanSubprocesses` is intentionally not implemented.
    };

    const models: ModelCatalog = {
      resolveModelInfo: (q) => kiloResolveModel(q),
      // Catalog-driven backend with no canonical default — fall
      // through to `config.backendDefaults.kilo`.
      getDefaultModelId: () => undefined,
      getRawModelInfo: (id) => kiloGetModelInfo(id),
      getSettingsPresentation: async (m, options) => {
        // Kilo's internal helper returns the bare picker shape;
        // wrap into the canonical `ModelPickerResult`. Kilo doesn't
        // expose pagination or a free-tier filter so the result is
        // always page 1 of 1 with filter "all".
        const inner = await kiloGetSettingsPresentation(
          m,
          options?.callbackPrefix,
        );
        return {
          ...inner,
          view: "models" as const,
          page: 1,
          totalPages: 1,
          filter: "all" as const,
          freeCount: 0,
          totalCount: inner.modelButtons.length,
        };
      },
      getProviders: () => kiloGetProviders(),
      getProviderModels: (p, pg, ps) => kiloGetProviderModels(p, pg, ps),
      formatModelError: (q, r) => kiloFormatModelError(q, r),
      listModels: (f) => kiloListModels(f),
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
