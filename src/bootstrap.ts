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
import { log } from "./util/log.js";
import type { TalonConfig } from "./util/config.js";
import type { QueryBackend, ContextManager } from "./core/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Frontend = {
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

// ── Bootstrap: config, env, plugins, workspace, storage ──────────────────────

/**
 * Load config, set env vars, load plugins, init workspace, load all storage.
 * Returns the loaded config for further use by the caller.
 */
export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const config = loadConfig();

  // Expose search config as env vars for gateway-actions
  if (config.braveApiKey) process.env.TALON_BRAVE_API_KEY = config.braveApiKey;
  if (config.searxngUrl) process.env.TALON_SEARXNG_URL = config.searxngUrl;

  // Load plugins (external tool packages)
  if (config.plugins.length > 0) {
    const { loadPlugins, getPluginPromptAdditions } = await import(
      "./core/plugin.js"
    );
    const frontends =
      options.frontendNames ??
      (Array.isArray(config.frontend)
        ? config.frontend
        : [config.frontend]);
    await loadPlugins(config.plugins, frontends);
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
): Promise<void> {
  let backend: QueryBackend;

  if (config.backend === "opencode") {
    const {
      initOpenCodeAgent,
      handleMessage: opencodeHandleMessage,
    } = await import("./backend/opencode/index.js");
    initOpenCodeAgent(config, frontend.getBridgePort);
    backend = { query: (params) => opencodeHandleMessage(params) };
    log("bot", "Backend: OpenCode");
  } else if (config.backend === "openrouter") {
    const {
      initOpenRouterAgent,
      handleMessage: openrouterHandleMessage,
    } = await import("./backend/openrouter/index.js");
    initOpenRouterAgent(config, frontend.getBridgePort);
    backend = { query: (params) => openrouterHandleMessage(params) };
    log("bot", "Backend: OpenRouter");
  } else {
    const {
      initAgent: initClaudeAgent,
      handleMessage: claudeHandleMessage,
    } = await import("./backend/claude-sdk/index.js");
    initClaudeAgent(config, frontend.getBridgePort);
    backend = { query: (params) => claudeHandleMessage(params) };
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
}
