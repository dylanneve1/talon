/**
 * Shared bootstrap logic used by both the main entry point (index.ts)
 * and the CLI chat command (cli.ts).
 *
 * Handles: config loading, env vars, plugin loading, workspace init,
 * storage loading, backend + dispatcher initialization.
 *
 * Frontend creation and lifecycle remain with the callers since they
 * differ (index.ts selects dynamically, cli.ts always uses terminal).
 */

import { loadConfig, rebuildSystemPrompt } from "./util/config.js";
import { initWorkspace } from "./util/workspace.js";
import { loadSessions } from "./storage/sessions.js";
import { loadChatSettings } from "./storage/chat-settings.js";
import { loadCronJobs } from "./storage/cron-store.js";
import { loadHistory } from "./storage/history.js";
import { loadMediaIndex } from "./storage/media-index.js";
import { cleanupOldLogs } from "./storage/daily-log.js";
import { initDispatcher } from "./core/dispatcher.js";
import { initPulse, resetPulseTimer } from "./core/pulse.js";
import { initCron } from "./core/cron.js";
import { initDream } from "./core/dream.js";
import { initHeartbeat } from "./core/heartbeat.js";
import { log } from "./util/log.js";
import type { TalonConfig } from "./util/config.js";
import type { QueryBackend, ContextManager } from "./core/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Frontend = {
  name: "telegram" | "terminal" | "teams";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type BootstrapOptions = {
  /** Override frontend names for plugin loading (e.g. ["terminal"]). */
  frontendNames?: string[];
};

export type BootstrapResult = {
  config: TalonConfig;
};

export type BackendAndDispatcherResult = {
  backend: QueryBackend;
};

// ── Bootstrap: config, env, plugins, workspace, storage ──────────────────────

/**
 * Load config, set env vars, load plugins, init workspace, load all storage.
 * Returns the loaded config for further use by the caller.
 */
export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const config = loadConfig();

  // Load plugins (external tool packages + built-in GitHub, MemPalace, Playwright)
  const hasPlugins =
    config.plugins.length > 0 ||
    config.github?.enabled === true ||
    config.mempalace?.enabled === true ||
    config.playwright?.enabled === true;
  if (hasPlugins) {
    const { loadPlugins, loadBuiltinPlugins, getPluginPromptAdditions } =
      await import("./core/plugin.js");

    // External plugins
    if (config.plugins.length > 0) {
      const frontends =
        options.frontendNames ??
        (Array.isArray(config.frontend) ? config.frontend : [config.frontend]);
      await loadPlugins(config.plugins, frontends);
    }

    // Built-in plugins (GitHub, MemPalace, Playwright) — shared with hot-reload
    await loadBuiltinPlugins(config);

    rebuildSystemPrompt(config, getPluginPromptAdditions());
  }

  initWorkspace(config.workspace);
  loadSessions();
  loadChatSettings();
  loadCronJobs();
  loadHistory();
  loadMediaIndex();
  cleanupOldLogs();

  return { config };
}

// ── Backend + dispatcher wiring ──────────────────────────────────────────────

/**
 * Create the AI backend and wire the dispatcher.
 * Call this after creating the frontend.
 */
export async function initBackendAndDispatcher(
  config: TalonConfig,
  frontend: Frontend,
): Promise<BackendAndDispatcherResult> {
  let backend: QueryBackend;

  if (config.backend === "opencode") {
    const { initOpenCodeAgent, handleMessage: opencodeHandleMessage } =
      await import("./backend/opencode/index.js");
    const ocModelProvider =
      await import("./backend/opencode/model-provider.js");
    initOpenCodeAgent(config, frontend.getBridgePort, frontend.name);
    backend = {
      query: (params) => opencodeHandleMessage(params),
      resolveModel: (q) => ocModelProvider.resolveModel(q),
      getModelInfo: (id) => ocModelProvider.getModelInfo(id),
      getSettingsPresentation: (m, prefix) =>
        ocModelProvider.getSettingsPresentation(m, prefix),
      getProviders: () => ocModelProvider.getProviders(),
      getProviderModels: (p, pg, ps) =>
        ocModelProvider.getProviderModels(p, pg, ps),
      formatModelError: (q, r) => ocModelProvider.formatModelError(q, r),
      getSessionSnapshot: async (sessionId) => {
        const { getOpenCodeSessionSnapshot } =
          await import("./backend/opencode/index.js");
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
    log("bot", "Backend: OpenCode");
  } else {
    const {
      initAgent: initClaudeAgent,
      handleMessage: claudeHandleMessage,
      warmSession: claudeWarmSession,
      updateSystemPrompt: claudeUpdateSystemPrompt,
      getActiveQuery,
      buildMcpServers,
    } = await import("./backend/claude-sdk/index.js");
    const { getPluginMcpServers } = await import("./core/plugin.js");
    const claudeModelProvider =
      await import("./backend/claude-sdk/model-provider.js");
    await initClaudeAgent(config, frontend.getBridgePort);
    backend = {
      query: (params) => claudeHandleMessage(params),
      warmSession: (chatId) => claudeWarmSession(chatId),
      updateSystemPrompt: (prompt) => claudeUpdateSystemPrompt(prompt),
      resolveModel: (q) => claudeModelProvider.resolveModel(q),
      getModelInfo: (id) => claudeModelProvider.getModelInfo(id),
      getSettingsPresentation: (m, prefix) =>
        claudeModelProvider.getSettingsPresentation(m, prefix),
      getProviders: () => claudeModelProvider.getProviders(),
      getProviderModels: (p, pg, ps) =>
        claudeModelProvider.getProviderModels(p, pg, ps),
      formatModelError: (q, r) => claudeModelProvider.formatModelError(q, r),
      refreshMcpServers: async (chatId) => {
        const qi = getActiveQuery(chatId);
        if (!qi) return null;
        // Two-phase teardown: first remove all MCP servers so the SDK
        // sends a close/shutdown to each subprocess via stdio (OS-agnostic),
        // then install the fresh set. This ensures old processes receive an
        // explicit termination message and exit before new ones spawn.
        await qi.setMcpServers({});
        const bridgeUrl = `http://127.0.0.1:${frontend.getBridgePort()}`;
        const freshServers = {
          ...buildMcpServers(chatId),
          ...getPluginMcpServers(bridgeUrl, chatId),
        };
        return qi.setMcpServers(freshServers);
      },
    };
    log("bot", "Backend: Claude SDK");
  }

  initDispatcher({
    backend,
    context: frontend.context,
    sendTyping: frontend.sendTyping,
    onActivity: () => resetPulseTimer(),
  });

  initPulse();
  initCron({ sendMessage: frontend.sendMessage });

  // Only enable mempalace dream integration if the plugin actually registered
  let mempalaceCfg: { pythonPath: string; palacePath: string } | undefined;
  if (config.mempalace?.enabled) {
    const { getPlugin } = await import("./core/plugin.js");
    if (getPlugin("mempalace")) {
      const { dirs, files: pathFiles } = await import("./util/paths.js");
      mempalaceCfg = {
        pythonPath: config.mempalace.pythonPath ?? pathFiles.mempalacePython,
        palacePath: config.mempalace.palacePath ?? dirs.palace,
      };
    } else {
      log(
        "mempalace",
        "Enabled in config but plugin not registered — skipping dream integration",
      );
    }
  }

  initDream({
    model: config.model,
    dreamModel: config.dreamModel,
    claudeBinary: config.claudeBinary,
    workspace: config.workspace,
    mempalace: mempalaceCfg,
  });
  initHeartbeat({
    model: config.model,
    heartbeatModel: config.heartbeatModel,
    claudeBinary: config.claudeBinary,
    workspace: config.workspace,
  });

  return { backend };
}
