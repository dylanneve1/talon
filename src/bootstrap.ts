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
import { bus } from "./core/bus/index.js";
import { appendToJournal } from "./storage/journal.js";
import { initPulse, resetPulseTimer } from "./core/background/pulse.js";
import { initCron } from "./core/background/cron.js";
import {
  initTriggers,
  resumeAfterRestart as resumeTriggersAfterRestart,
} from "./core/background/triggers/index.js";
import { initDream, maybeStartDream } from "./core/background/dream.js";
import { initHeartbeat } from "./core/background/heartbeat/index.js";
import { log, logWarn, logDebug } from "./util/log.js";
import type { TalonConfig } from "./util/config.js";
import {
  isNativeChatId,
  isDiscordChatId,
  isTelegramChatId,
  isTerminalChatId,
  isTeamsChatId,
} from "./util/chat-id.js";
import type { ContextManager } from "./core/types.js";
import type { Backend } from "./core/agent-runtime/capabilities.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Frontend = {
  name: "telegram" | "terminal" | "teams" | "discord" | "native";
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type FrontendSelection = Frontend | Frontend[];

function normalizeFrontends(frontend: FrontendSelection): Frontend[] {
  const list = Array.isArray(frontend) ? frontend : [frontend];
  const byName = new Map<Frontend["name"], Frontend>();
  for (const item of list) byName.set(item.name, item);
  return [...byName.values()];
}

function resolveFrontendName(
  chatId: string | undefined,
  frontends: Frontend[],
): Frontend["name"] {
  if (frontends.length === 1) return frontends[0].name;
  if (chatId) {
    if (
      isTerminalChatId(chatId) &&
      frontends.some((f) => f.name === "terminal")
    )
      return "terminal";
    if (isNativeChatId(chatId) && frontends.some((f) => f.name === "native"))
      return "native";
    if (isTeamsChatId(chatId) && frontends.some((f) => f.name === "teams"))
      return "teams";
    if (isDiscordChatId(chatId) && frontends.some((f) => f.name === "discord"))
      return "discord";
    if (
      isTelegramChatId(chatId) &&
      frontends.some((f) => f.name === "telegram")
    )
      return "telegram";
  }
  const firstNonTerminal = frontends.find((f) => f.name !== "terminal");
  return firstNonTerminal?.name ?? frontends[0].name;
}

function resolveFrontend(
  chatId: string | undefined,
  frontends: Frontend[],
): Frontend {
  const name = resolveFrontendName(chatId, frontends);
  const resolved = frontends.find((frontend) => frontend.name === name);
  if (!resolved) {
    throw new Error(`No frontend available for ${chatId ?? "unknown chat"}`);
  }
  return resolved;
}

function resolveFrontendByNumericId(
  chatId: number,
  stringId: string | undefined,
  frontends: Frontend[],
): Frontend {
  return resolveFrontend(stringId ?? String(chatId), frontends);
}

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

  // Load plugins (external tool packages + built-in GitHub, MemPalace, mem0, Playwright)
  const hasPlugins =
    config.plugins.length > 0 ||
    config.github?.enabled === true ||
    config.mempalace?.enabled === true ||
    config.mem0?.enabled === true ||
    config.playwright?.enabled === true;
  if (hasPlugins) {
    const { loadPlugins, loadBuiltinPlugins, getPluginPromptAdditions } =
      await import("./core/plugin/index.js");

    // External plugins
    if (config.plugins.length > 0) {
      const frontends =
        options.frontendNames ??
        (Array.isArray(config.frontend) ? config.frontend : [config.frontend]);
      await loadPlugins(config.plugins, frontends);
    }

    // Built-in plugins (GitHub, MemPalace, mem0, Playwright) — shared with hot-reload
    await loadBuiltinPlugins(config);

    rebuildSystemPrompt(config, getPluginPromptAdditions());
  }

  // MCP hub — daemon-hosted MCP-over-HTTP for every backend (tool
  // trimming + brave key come from config; endpoints mount on the
  // gateway HTTP server).
  const { initHub } = await import("./core/mcp-hub/index.js");
  initHub({
    disabledTools: config.disabledTools,
    disabledToolTags: config.disabledToolTags,
    braveApiKey: config.braveApiKey,
    nativeTools: config.nativeTools,
  });

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
  frontend: FrontendSelection,
): Promise<BackendAndDispatcherResult> {
  const frontends = normalizeFrontends(frontend);

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
    getBackendIdForChat,
    rebindChat,
    releaseChat,
    isBackendAvailable,
    isModelValidForBackend,
  } = await import("./core/engine/backend-controller/index.js");

  // Boot the backend pool — binds the chat / heartbeat / dream roles
  // from `config.backend`, `config.heartbeatBackend`,
  // `config.dreamBackend`. When two roles point at the same id the
  // pool reuses one instance (refcounted) — a single-backend setup
  // still spins up exactly one instance.
  await initBackendPool(config, {
    getBridgePort: () => resolveFrontend(undefined, frontends).getBridgePort(),
    frontendName: resolveFrontend(undefined, frontends).name,
  });
  const backend = getBackendForRole("chat");

  // Model audit — verify the models pinned in config still exist on
  // their backends. A withdrawn model silently runs the backend
  // default; this is the one loud signal that the config is stale.
  // Fire-and-forget: never blocks or fails boot.
  void (async () => {
    try {
      const { auditConfiguredModels } =
        await import("./core/engine/model-audit.js");
      const findings = await auditConfiguredModels(config, (role) =>
        getBackendForRole(role),
      );
      for (const finding of findings) {
        logWarn("config", `[MODEL AUDIT] ${finding.message}`);
      }
    } catch (err) {
      logDebug("config", `Model audit skipped: ${String(err)}`);
    }
  })();

  const context: ContextManager = {
    acquire(chatId: number, stringId?: string, frontendName?: string): void {
      const frontendToUse =
        frontends.find((item) => item.name === frontendName) ??
        resolveFrontendByNumericId(chatId, stringId, frontends);
      frontendToUse.context.acquire(chatId, stringId, frontendToUse.name);
    },
    release(chatId: number, stringId?: string): void {
      resolveFrontendByNumericId(chatId, stringId, frontends).context.release(
        chatId,
        stringId,
      );
    },
    getMessageCount(chatId: number, stringId?: string): number {
      return resolveFrontendByNumericId(
        chatId,
        stringId,
        frontends,
      ).context.getMessageCount(chatId, stringId);
    },
  };

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
        // A boot-time rebind failure is usually TRANSIENT (backend slow to
        // spawn, auth endpoint briefly unreachable) — it must not destroy
        // the user's persisted choice, session, and history. Retry once,
        // then keep the setting and move on: the chat runs on the default
        // backend until a later switch succeeds, and clients keep showing
        // the user's chosen backend from settings (the source of truth).
        let result = await rebindChat(cid, settings.backend, config);
        if (!result.ok) {
          await new Promise((r) => setTimeout(r, 1500));
          result = await rebindChat(cid, settings.backend, config);
        }
        if (!result.ok) {
          log(
            "bot",
            `Per-chat backend rebind failed for ${cid} → ${settings.backend}: ${result.error} — keeping the setting; will serve on the default backend until re-selected`,
          );
        }
      }
    }

    // Only validate the stored model against the backend that will really
    // serve this chat. After a kept-but-unbound override (transient rebind
    // failure above) the chat temporarily runs on the default backend — the
    // stored model belongs to the chosen backend, so validating it against
    // the default would wrongly clear it.
    const bindingMatchesSetting =
      !settings.backend || getBackendIdForChat(cid) === settings.backend;
    const currentModel = getAllChatSettings()[cid]?.model;
    if (currentModel && bindingMatchesSetting) {
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
        await import("./core/engine/backend-controller/index.js");
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
        await import("./core/engine/backend-controller/index.js");
      return resolveExplicitModelRef(
        modelId,
        getBE(chatId),
        getBackendIdForChat(chatId),
      );
    },
    context,
    sendTyping: async (chatId: number, stringId?: string) =>
      resolveFrontendByNumericId(chatId, stringId, frontends).sendTyping(
        chatId,
      ),
  });

  // Cross-subsystem reactions ride the bus, so the Weaver stays ignorant of
  // dream and pulse: a bound turn kicks the fire-and-forget dream check, a
  // completed turn resets the pulse idle timer.
  bus.subscribe("turn.started", () => maybeStartDream());
  bus.subscribe("turn.completed", () => resetPulseTimer());
  // The journal is the bus's durable tail: every published event lands in
  // talon.db so history survives restarts (`talon events --history`,
  // `talon ps --all`). Append failures are logged and swallowed inside.
  bus.subscribeAll((event) => appendToJournal(event));

  initPulse();
  initCron({
    sendMessage: async (chatId: number, text: string, stringId?: string) =>
      resolveFrontendByNumericId(chatId, stringId, frontends).sendMessage(
        chatId,
        text,
      ),
    // Isolated cron query jobs with no model override fall back to the chat's
    // active model + backend.
    resolveChatModel: async (chatId: string) => {
      const { resolveActiveModelForChat } =
        await import("./core/models/active-model.js");
      const { getBackendIdForChat, getBackendForChat: getBE } =
        await import("./core/engine/backend-controller/index.js");
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
    const { getPlugin } = await import("./core/plugin/index.js");
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
  const frontendNames = frontends
    .filter((f) => f.name !== "terminal")
    .map((f) => f.name);

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
