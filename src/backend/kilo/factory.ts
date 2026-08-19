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
  type SessionBackend,
  type SystemControl,
  type ToolRuntime,
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
  refreshPluginMcpServers as kiloRefreshPluginMcpServers,
  updateSystemPrompt as kiloUpdateSystemPrompt,
  warmSession as kiloWarmSession,
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
      getSettingsPresentation: (m, options) =>
        kiloGetSettingsPresentation(m, options),
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

    const tools: ToolRuntime = {
      refreshTools: (chatId) => kiloRefreshPluginMcpServers(chatId),
    };

    // Session state lives on the Kilo server, and `/reset` already clears
    // Talon's stored id centrally (storage/sessions.ts), so the next turn
    // creates a fresh one — no `resetChat` needed. `warmSession` front-loads
    // that creation plus the plugin-MCP sweep, matching what the Claude
    // backend does after a reset.
    const sessions: SessionBackend = {
      warmSession: (chatId) => kiloWarmSession(chatId),
    };

    const control: SystemControl = {
      updateSystemPrompt: (prompt) => kiloUpdateSystemPrompt(prompt),
    };

    const backend = composeBackend({
      id: "kilo",
      label: "Kilo",
      cacheMetrics: "readwrite",
      chat,
      background,
      models,
      sessions,
      tools,
      usage,
      control,
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
