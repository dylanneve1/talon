/**
 * Claude SDK backend factory — wires the Anthropic Claude Agent SDK
 * into the registry.
 *
 * Unlike Kilo/OpenCode (which run a local HTTP server), the Claude SDK
 * spawns a per-query subprocess. So this factory also wires the
 * `tools.refreshTools` hot-swap path used by plugin reload + the
 * `background.evictOrphanSubprocesses` cleanup helper.
 *
 * Returns the composed `Backend` shape directly — capability slots
 * for chat / background / models / sessions / tools / control. No
 * fat-optional `QueryBackend` surface.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import { log } from "../../util/log.js";
import { getPluginMcpServers } from "../../core/plugin.js";
import { toEventStream } from "../shared/to-event-stream.js";
import {
  composeBackend,
  type ChatBackend,
  type BackgroundRunner,
  type ModelCatalog,
  type SessionBackend,
  type SystemControl,
  type ToolRuntime,
} from "../../core/agent-runtime/capabilities.js";
import { makeBareModelRef } from "../../core/agent-runtime/model-ref.js";

import {
  initAgent as initClaudeAgent,
  updateSystemPrompt as claudeUpdateSystemPrompt,
  handleMessage as claudeHandleMessage,
  warmSession as claudeWarmSession,
  getActiveQuery,
  buildMcpServers,
  runOneShotAgent as claudeRunOneShotAgent,
  evictOrphanSubprocesses as claudeEvictOrphanSubprocesses,
} from "./index.js";

import * as modelProvider from "./model-provider.js";

const claudeSdkFactory: BackendFactory = {
  // The config schema uses `"claude"` for backward compatibility with
  // talon.json files predating the registry. Matching the id here means
  // no migration is needed.
  id: "claude",
  label: "Anthropic",

  async init(config, ctx) {
    await initClaudeAgent(config, ctx.getBridgePort);
    log("bot", "Backend: Claude SDK (@anthropic-ai/claude-agent-sdk)");

    const chat: ChatBackend = {
      runChatTurn: (params) =>
        toEventStream((p) => claudeHandleMessage(p), params),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => claudeRunOneShotAgent(p),
      evictOrphanSubprocesses: (label) => claudeEvictOrphanSubprocesses(label),
    };

    const models: ModelCatalog = {
      async resolveModel(query) {
        const resolution = await modelProvider.resolveModel(query);
        if (resolution.kind === "exact") {
          return {
            kind: "exact",
            model: makeBareModelRef("claude", resolution.model.id),
            storedValue: resolution.storedValue,
          };
        }
        if (resolution.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            matches: resolution.matches.map((m) =>
              makeBareModelRef("claude", m.id),
            ),
          };
        }
        return { kind: "missing" };
      },
      async listModels(filter) {
        const result = await modelProvider.listModels(
          filter.freeOnly ? "free" : "all",
        );
        return {
          models: result.models.map((m) => makeBareModelRef("claude", m.id)),
          total: result.total,
        };
      },
      // Claude SDK ships a canonical `"default"` alias the runtime
      // resolves to the recommended model. Returning it keeps reset
      // + backend-switch on "Default (recommended)" rather than
      // freezing a specific id that may go stale across SDK upgrades.
      async getDefaultModel() {
        return makeBareModelRef("claude", "default", "backend-default");
      },
      async getModelInfo(id) {
        const info = await modelProvider.getModelInfo(id);
        if (!info) return undefined;
        return makeBareModelRef("claude", info.id);
      },

      resolveModelInfo: (q) => modelProvider.resolveModel(q),
      getDefaultModelId: () => "default",
      getRawModelInfo: (id) => modelProvider.getModelInfo(id),
      getSettingsPresentation: (m, options) =>
        modelProvider.getSettingsPresentation(m, options),
      getProviders: () => modelProvider.getProviders(),
      getProviderModels: (p, pg, ps) =>
        modelProvider.getProviderModels(p, pg, ps),
      formatModelError: (q, r) => modelProvider.formatModelError(q, r),
      listModelsRaw: (f) => modelProvider.listModels(f),
    };

    const sessions: SessionBackend = {
      // Claude SDK's per-turn subprocess model has no shared session
      // state to reset — the SDK starts fresh on each handleMessage.
      // Talon's per-chat session id (stored in `storage/sessions.ts`)
      // is what the dispatcher's `/reset` actually clears.
      resetChat: () => undefined,
      warmSession: (chatId) => claudeWarmSession(chatId),
    };

    const tools: ToolRuntime = {
      refreshTools: async (chatId) => {
        const qi = getActiveQuery(chatId);
        if (!qi) return null;
        // Two-phase teardown: remove all MCP servers first so each
        // subprocess receives an OS-agnostic shutdown via stdio, then
        // install the fresh set.
        await qi.setMcpServers({});
        const bridgeUrl = `http://127.0.0.1:${ctx.getBridgePort()}`;
        const freshServers = {
          ...buildMcpServers(chatId),
          ...getPluginMcpServers(bridgeUrl, chatId),
        };
        return qi.setMcpServers(freshServers);
      },
    };

    const control: SystemControl = {
      updateSystemPrompt: (prompt) => claudeUpdateSystemPrompt(prompt),
    };

    const backend = composeBackend({
      id: "claude",
      label: "Anthropic",
      cacheMetrics: "readwrite",
      chat,
      background,
      models,
      sessions,
      tools,
      control,
    });

    return { backend };
  },
};

registerBackend(claudeSdkFactory);
