/**
 * Claude SDK backend factory — wires the Anthropic Claude Agent SDK
 * into the registry.
 *
 * Unlike Kilo/OpenCode (which run a local HTTP server), the Claude SDK
 * spawns a per-query subprocess. So this factory also wires the
 * `refreshMcpServers` hot-swap path used by plugin reload + the
 * `evictOrphanSubprocesses` cleanup helper.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import type { QueryBackend } from "../../core/types.js";
import { log } from "../../util/log.js";
import { getPluginMcpServers } from "../../core/plugin.js";

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

// ── Factory ────────────────────────────────────────────────────────────────

const claudeSdkFactory: BackendFactory = {
  // The config schema uses `"claude"` for backward compatibility with
  // talon.json files predating the registry. Matching the id here means
  // no migration is needed.
  id: "claude",
  label: "Anthropic",

  async init(config, ctx) {
    await initClaudeAgent(config, ctx.getBridgePort);
    log("bot", "Backend: Claude SDK");

    const backend: QueryBackend = {
      query: (params) => claudeHandleMessage(params),
      warmSession: (chatId) => claudeWarmSession(chatId),
      updateSystemPrompt: (prompt) => claudeUpdateSystemPrompt(prompt),
      resolveModel: (q) => modelProvider.resolveModel(q),
      getModelInfo: (id) => modelProvider.getModelInfo(id),
      getSettingsPresentation: (m, prefix) =>
        modelProvider.getSettingsPresentation(m, prefix),
      getProviders: () => modelProvider.getProviders(),
      getProviderModels: (p, pg, ps) =>
        modelProvider.getProviderModels(p, pg, ps),
      formatModelError: (q, r) => modelProvider.formatModelError(q, r),
      listModels: (f) => modelProvider.listModels(f),
      backendLabel: "Anthropic",
      refreshMcpServers: async (chatId) => {
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
      runOneShotAgent: (p) => claudeRunOneShotAgent(p),
      evictOrphanSubprocesses: (label) => claudeEvictOrphanSubprocesses(label),
    };

    return { backend };
  },
};

registerBackend(claudeSdkFactory);
