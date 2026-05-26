/**
 * OpenCode backend factory — wires OpenCode into the registry.
 *
 * Mirrors the Kilo factory in structure. OpenCode and Kilo share the
 * same protocol shape (Kilo is a fork) so the adapter logic is nearly
 * identical — only the SDK import and a few constant names differ.
 *
 * Returns a composed `Backend` with capability slots for chat,
 * background, models, and usage.
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
  initOpenCodeAgent,
  stopOpenCodeServer,
  handleMessage as ocHandleMessage,
  runOneShotAgent as ocRunOneShotAgent,
  getOpenCodeSessionSnapshot,
  resolveModel as ocResolveModel,
  getModelInfo as ocGetModelInfo,
  getSettingsPresentation as ocGetSettingsPresentation,
  getProviders as ocGetProviders,
  getProviderModels as ocGetProviderModels,
  formatModelError as ocFormatModelError,
  listModels as ocListModels,
} from "./index.js";

const opencodeFactory: BackendFactory = {
  id: "opencode",
  label: "OpenCode",

  async init(config, ctx) {
    initOpenCodeAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: OpenCode (@opencode-ai/sdk)");

    const chat: ChatBackend = {
      runChatTurn: (params) => toEventStream((p) => ocHandleMessage(p), params),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => ocRunOneShotAgent(p),
    };

    const models: ModelCatalog = {
      async resolveModel(query) {
        const resolution = await ocResolveModel(query);
        if (resolution.kind === "exact") {
          return {
            kind: "exact",
            model: makeBareModelRef("opencode", resolution.model.id),
            storedValue: resolution.storedValue,
          };
        }
        if (resolution.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            matches: resolution.matches.map((m) =>
              makeBareModelRef("opencode", m.id),
            ),
          };
        }
        return { kind: "missing" };
      },
      async listModels(filter) {
        const result = await ocListModels(filter.freeOnly ? "free" : "all");
        return {
          models: result.models.map((m) => makeBareModelRef("opencode", m.id)),
          total: result.total,
        };
      },
      getDefaultModel: () => Promise.resolve(null),
      async getModelInfo(id) {
        const info = await ocGetModelInfo(id);
        if (!info) return undefined;
        return makeBareModelRef("opencode", info.id);
      },

      resolveModelInfo: (q) => ocResolveModel(q),
      getDefaultModelId: () => undefined,
      getRawModelInfo: (id) => ocGetModelInfo(id),
      getSettingsPresentation: async (m, options) => {
        const legacy = await ocGetSettingsPresentation(
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
      getProviders: () => ocGetProviders(),
      getProviderModels: (p, pg, ps) => ocGetProviderModels(p, pg, ps),
      formatModelError: (q, r) => ocFormatModelError(q, r),
      listModelsRaw: (f) => ocListModels(f),
    };

    const usage: UsageTelemetry = {
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
    };

    const backend = composeBackend({
      id: "opencode",
      label: "OpenCode",
      cacheMetrics: "readwrite",
      chat,
      background,
      models,
      usage,
    });

    return {
      backend,
      cleanup: () => {
        stopOpenCodeServer();
      },
    };
  },
};

registerBackend(opencodeFactory);
