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
  refreshPluginMcpServers as ocRefreshPluginMcpServers,
  updateSystemPrompt as ocUpdateSystemPrompt,
  warmSession as ocWarmSession,
} from "./index.js";

const opencodeFactory: BackendFactory = {
  id: "opencode",
  label: "OpenCode",

  async init(config, ctx) {
    initOpenCodeAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: OpenCode (@opencode-ai/sdk)");

    const chat: ChatBackend = {
      runChatTurn: (params) =>
        handlerToEvents((p) => ocHandleMessage(p), params),
      interruptChatTurn: (chatId) => interruptChatTurn(chatId),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => ocRunOneShotAgent(p),
    };

    const models: ModelCatalog = {
      resolveModelInfo: (q) => ocResolveModel(q),
      // Catalog-driven backend with no canonical default.
      getDefaultModelId: () => undefined,
      getRawModelInfo: (id) => ocGetModelInfo(id),
      getSettingsPresentation: async (m, options) => {
        const inner = await ocGetSettingsPresentation(
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
      getProviders: () => ocGetProviders(),
      getProviderModels: (p, pg, ps) => ocGetProviderModels(p, pg, ps),
      formatModelError: (q, r) => ocFormatModelError(q, r),
      listModels: (f) => ocListModels(f),
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

    const tools: ToolRuntime = {
      refreshTools: (chatId) => ocRefreshPluginMcpServers(chatId),
    };

    // Session state lives on the OpenCode server, and `/reset` already
    // clears Talon's stored id centrally (storage/sessions.ts), so the
    // next turn creates a fresh one — no `resetChat` needed. `warmSession`
    // front-loads that creation plus the plugin-MCP sweep, matching what
    // the Claude backend does after a reset.
    const sessions: SessionBackend = {
      warmSession: (chatId) => ocWarmSession(chatId),
    };

    const control: SystemControl = {
      updateSystemPrompt: (prompt) => ocUpdateSystemPrompt(prompt),
    };

    const backend = composeBackend({
      id: "opencode",
      label: "OpenCode",
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
        stopOpenCodeServer();
      },
    };
  },
};

registerBackend(opencodeFactory);
