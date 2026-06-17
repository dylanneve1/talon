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
import { loadSessions, resetSession } from "./storage/sessions.js";
import { loadChatSettings } from "./storage/chat-settings.js";
import { loadCronJobs } from "./storage/cron-store.js";
import { loadTriggers } from "./storage/trigger-store.js";
import { clearHistory, loadHistory } from "./storage/history.js";
import { loadMediaIndex } from "./storage/media-index.js";
import { cleanupOldLogs } from "./storage/daily-log.js";
import {
  initDispatcher,
  execute as dispatcherExecute,
} from "./core/engine/dispatcher.js";
import { initPulse, resetPulseTimer } from "./core/background/pulse.js";
import { initCron } from "./core/background/cron.js";
import {
  initTriggers,
  resumeAfterRestart as resumeTriggersAfterRestart,
} from "./core/background/triggers.js";
import { initDream } from "./core/background/dream.js";
import { initHeartbeat } from "./core/background/heartbeat.js";
import { log } from "./util/log.js";
import type { TalonConfig } from "./util/config.js";
import type { ContextManager } from "./core/types.js";
import type { Backend } from "./core/agent-runtime/capabilities.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Frontend = {
  name: "telegram" | "terminal" | "teams" | "discord";
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
  backend: Backend;
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
  loadTriggers();
  loadHistory();
  loadMediaIndex();
  cleanupOldLogs();

  return { config };
}

// ── Backend + dispatcher wiring ──────────────────────────────────────────────

/**
 * Create the AI backend and wire the dispatcher.
 * Call this after creating the frontend.
 *
 * The backend controller (`core/engine/backend-controller.ts`) is the single
 * source of truth for the active backend. Dispatcher / dream /
 * heartbeat all read through `getActiveBackend()` so a runtime swap
 * via `switchBackend(id, config)` propagates without any re-init.
 */
export async function initBackendAndDispatcher(
  config: TalonConfig,
  frontend: Frontend,
): Promise<BackendAndDispatcherResult> {
  // Register all built-in backends via side-effect import. Adding a new
  // backend is now strictly additive: drop a `factory.ts` under the new
  // backend dir and import it here. No conditionals here change.
  await import("./backend/claude-sdk/factory.js");
  await import("./backend/opencode/factory.js");
  await import("./backend/kilo/factory.js");
  await import("./backend/codex/factory.js");
  await import("./backend/openai-agents/factory.js");

  const {
    initBackendPool,
    getBackendForRole,
    getBackendForChat,
    rebindChat,
    releaseChat,
    isBackendAvailable,
    isModelValidForBackend,
  } = await import("./core/engine/backend-controller.js");

  // Boot the backend pool — binds the chat / heartbeat / dream roles
  // from `config.backend`, `config.heartbeatBackend`,
  // `config.dreamBackend`. When two roles point at the same id the
  // pool reuses one instance (refcounted) — a single-backend setup
  // still spins up exactly one instance.
  await initBackendPool(config, {
    getBridgePort: frontend.getBridgePort,
    frontendName: frontend.name,
  });
  const backend = getBackendForRole("chat");

  // One-shot legacy migration: any chat-settings entry still holding
  // the old single-slot `model` field gets moved into
  // `modelByBackend[chatSettings.backend ?? config.backend]`. Idempotent;
  // safe to call on every boot. After this point the resolver no longer
  // needs the legacy-fallback branch — every active chat's model lives
  // in the per-backend map.
  const { migrateLegacyModelField } =
    await import("./storage/chat-settings.js");
  migrateLegacyModelField(config.backend, (id) =>
    isBackendAvailable(id, config),
  );

  // Re-acquire any persisted per-chat backend/model overrides so chats
  // resume exactly where they were before restart. If a backend has
  // since been disabled/removed, or the stored model is no longer valid
  // for the backend that would serve it, clear the override and reset
  // volatile chat state so the next user message starts a fresh default
  // session instead of crashing on an orphaned model id.
  const { getAllChatSettings, setChatBackend, setChatModel } =
    await import("./storage/chat-settings.js");
  for (const [cid, settings] of Object.entries(getAllChatSettings())) {
    let resetVolatileState = false;

    if (settings.backend) {
      if (!isBackendAvailable(settings.backend, config)) {
        log(
          "bot",
          `Per-chat backend ${settings.backend} for ${cid} is no longer available — resetting chat to default backend`,
        );
        await releaseChat(cid);
        setChatBackend(cid, undefined);
        setChatModel(cid, undefined);
        resetVolatileState = true;
      } else {
        const result = await rebindChat(cid, settings.backend, config);
        if (!result.ok) {
          log(
            "bot",
            `Per-chat backend rebind failed for ${cid} → ${settings.backend}: ${result.error} — resetting chat to default backend`,
          );
          await releaseChat(cid);
          setChatBackend(cid, undefined);
          setChatModel(cid, undefined);
          resetVolatileState = true;
        }
      }
    }

    const currentModel = getAllChatSettings()[cid]?.model;
    if (currentModel) {
      const be = getBackendForChat(cid);
      try {
        const valid = await isModelValidForBackend(be, currentModel);
        if (!valid) {
          log(
            "bot",
            `Per-chat model ${currentModel} for ${cid} is not valid for its backend — resetting model to default`,
          );
          setChatModel(cid, undefined);
          resetVolatileState = true;
        }
      } catch (err) {
        log(
          "bot",
          `Per-chat model validation failed for ${cid} (${currentModel}): ${
            err instanceof Error ? err.message : String(err)
          } — keeping stored model`,
        );
      }
    }

    if (resetVolatileState) {
      resetSession(cid);
      clearHistory(cid);
    }
  }

  initDispatcher({
    // Dispatcher reads the backend per query so per-chat overrides
    // and chat-role rebinds both propagate without re-init. The
    // chat id is always present from the dispatcher, but the type
    // is `chatId?: string` to keep test stubs simple — fall back to
    // the chat-role default if a caller ever passes `undefined`.
    getBackend: (chatId?: string) =>
      chatId ? getBackendForChat(chatId) : getBackendForRole("chat"),
    // Send-time guard: the dispatcher walks the active-model chain
    // before calling backend.query. When `model` is null (catalog-
    // driven backend with no per-chat pick and no operator default),
    // dispatcher refuses and replies with a /model prompt instead
    // of submitting an empty id to the backend.
    resolveActiveModel: async (chatId: string) => {
      const { resolveActiveModelForChat } =
        await import("./core/models/active-model.js");
      const { getBackendIdForChat, getBackendForChat: getBE } =
        await import("./core/engine/backend-controller.js");
      const beId = getBackendIdForChat(chatId);
      const be = getBE(chatId);
      const { model, ref } = await resolveActiveModelForChat(
        chatId,
        be,
        beId,
        config,
      );
      return { model, ref, backendId: beId };
    },
    // Per-run model override (triggers/cron): validate + materialise an
    // explicit model id against the chat's backend. Returns null when the id
    // isn't selectable, so the dispatcher falls back to the chat model.
    // Restricted to the chat's own backend so the session still resumes.
    resolveModelOverride: async (chatId: string, modelId: string) => {
      const { resolveExplicitModelRef } =
        await import("./core/models/active-model.js");
      const { getBackendIdForChat, getBackendForChat: getBE } =
        await import("./core/engine/backend-controller.js");
      return resolveExplicitModelRef(
        modelId,
        getBE(chatId),
        getBackendIdForChat(chatId),
      );
    },
    context: frontend.context,
    sendTyping: frontend.sendTyping,
    onActivity: () => resetPulseTimer(),
  });

  initPulse();
  initCron({
    sendMessage: frontend.sendMessage,
    // Isolated cron query jobs with no model override fall back to the chat's
    // active model + backend.
    resolveChatModel: async (chatId: string) => {
      const { resolveActiveModelForChat } =
        await import("./core/models/active-model.js");
      const { getBackendIdForChat, getBackendForChat: getBE } =
        await import("./core/engine/backend-controller.js");
      const beId = getBackendIdForChat(chatId);
      const { model } = await resolveActiveModelForChat(
        chatId,
        getBE(chatId),
        beId,
        config,
      );
      return { model, backendId: beId };
    },
  });
  initTriggers({ execute: dispatcherExecute });
  resumeTriggersAfterRestart().catch((err) =>
    log("triggers", `resumeAfterRestart failed: ${err}`),
  );

  // Soul — initialize the identity kernel singleton from config so the prompt
  // injection / dream hooks see the right enabled state. Off by default; a
  // failure here must never block startup.
  try {
    const { SoulService, setSoul } = await import("./core/soul/service.js");
    setSoul(
      SoulService.create({
        enabled: config.soul?.enabled ?? false,
        ...(config.soul?.path ? { path: config.soul.path } : {}),
      }),
    );
  } catch (err) {
    log("soul", `init skipped: ${String(err)}`);
  }

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

  // Configure the Claude SDK one-shot runner once we know mempalace state.
  // Loaded unconditionally because dream/heartbeat may target the Claude SDK
  // backend even when the chat backend is Kilo/OpenCode in some setups.
  // For Kilo/OpenCode chat backends this is dead state — harmless.
  const { initClaudeOneShot } =
    await import("./backend/claude-sdk/one-shot.js");
  initClaudeOneShot({
    claudeBinary: config.claudeBinary,
    mempalace: mempalaceCfg,
  });

  initDream({
    model: config.model,
    dreamModel: config.dreamModel,
    workspace: config.workspace,
    enabled: config.dream,
    getBackend: () => getBackendForRole("dream"),
  });
  // Heartbeat needs to know which non-terminal frontends are wired so it can
  // tell the agent it has outbound `${frontend}-tools` MCP servers available.
  // Terminal-only deployments get a stripped-down system prompt with no
  // outbound section.
  const frontendNames = (
    Array.isArray(config.frontend) ? config.frontend : [config.frontend]
  ).filter((f) => f !== "terminal");

  initHeartbeat({
    model: config.model,
    heartbeatModel: config.heartbeatModel,
    workspace: config.workspace,
    getBackend: () => getBackendForRole("heartbeat"),
    frontends: frontendNames,
    mempalace: Boolean(mempalaceCfg),
  });

  return { backend };
}
