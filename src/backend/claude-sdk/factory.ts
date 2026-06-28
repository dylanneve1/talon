/**
 * Claude SDK backend factory — wires the Anthropic Claude Agent SDK
 * into the registry.
 *
 * Unlike Kilo/OpenCode (which run a local HTTP server), the Claude SDK
 * spawns a per-query subprocess. So this factory also wires the
 * `tools.refreshTools` hot-swap path used by plugin reload + the
 * `background.evictOrphanSubprocesses` cleanup helper.
 *
 * Returns a composed `Backend` with capability slots for chat,
 * background, models, sessions, tools, and control.
 */

import { registerBackend } from "../../core/agent-runtime/backend-registry.js";
import type { BackendFactory } from "../../core/agent-runtime/backend-registry.js";
import { log } from "../../util/log.js";
import { getPluginMcpServers } from "../../core/plugin.js";
import {
  composeBackend,
  type ChatBackend,
  type BackgroundRunner,
  type ModelCatalog,
  type SessionBackend,
  type SystemControl,
  type ToolRuntime,
} from "../../core/agent-runtime/capabilities.js";

import {
  initAgent as initClaudeAgent,
  updateSystemPrompt as claudeUpdateSystemPrompt,
  warmSession as claudeWarmSession,
  getActiveQuery,
  buildMcpServers,
  runOneShotAgent as claudeRunOneShotAgent,
  evictOrphanSubprocesses as claudeEvictOrphanSubprocesses,
} from "./index.js";
import { runChatTurn as claudeRunChatTurn } from "./handler.js";
import { waitForMcpServersReady } from "./mcp-ready.js";

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
      runChatTurn: (params) => claudeRunChatTurn(params),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => claudeRunOneShotAgent(p),
      evictOrphanSubprocesses: (label) => claudeEvictOrphanSubprocesses(label),
    };

    const models: ModelCatalog = {
      resolveModelInfo: (q) => modelProvider.resolveModel(q),
      // Claude SDK ships a canonical `"default"` alias the runtime
      // resolves to the recommended model. Returning it keeps reset
      // + backend-switch on "Default (recommended)" rather than
      // freezing a specific id that may go stale across SDK upgrades.
      getDefaultModelId: () => "default",
      getRawModelInfo: (id) => modelProvider.getModelInfo(id),
      getSettingsPresentation: (m, options) =>
        modelProvider.getSettingsPresentation(m, options),
      getProviders: () => modelProvider.getProviders(),
      getProviderModels: (p, pg, ps) =>
        modelProvider.getProviderModels(p, pg, ps),
      formatModelError: (q, r) => modelProvider.formatModelError(q, r),
      listModels: (f) => modelProvider.listModels(f),
    };

    // Claude SDK's per-turn subprocess model has no shared session
    // state to reset; `warmSession` is the only useful hook. The
    // dispatcher's `/reset` clears Talon's stored session id via
    // `storage/sessions.ts:resetSession` regardless.
    const sessions: SessionBackend = {
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
        const result = await qi.setMcpServers(freshServers);
        // setMcpServers resolves on REGISTER, not CONNECT — MCP startup is
        // non-blocking. A stdio server that dials a slow remote (e.g. the
        // playwright plugin connecting to the Camoufox websocket) is still
        // 'pending' at this point and its tools are absent from the live
        // registry, so the turn would proceed with mcp__playwright-tools__*
        // stuck "connecting" until the next refresh. Wait (bounded) for the
        // newly-added servers to finish connecting before returning.
        await waitForMcpServersReady(qi, result.added);
        return result;
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
