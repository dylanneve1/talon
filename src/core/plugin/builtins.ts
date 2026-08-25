/**
 * Built-in plugin loading (GitHub / MemPalace / mem0 / Playwright) + the hot-reload
 * path that re-reads config, tears down, and re-loads everything.
 */

import { log, logError, logWarn } from "../../util/log.js";
import type { TalonConfig } from "../../util/config.js";
import { registry, reloadState } from "./registry.js";
import type { ProvisionOutcome } from "./provision.js";
import { NATIVE_RUNTIMES, type NativePluginId } from "./native-runtimes.js";
import { recordProvisionEvents } from "./provision-journal.js";
import {
  initPluginWithTimeout,
  loadPlugins,
  registerPlugin,
} from "./loader.js";

/**
 * Surface a provisioning outcome in the logs and the journal, and fire
 * its background reconcile task (fire-and-forget: the plugin is already
 * serving on whatever the outcome declared usable).
 */
function reportProvision(
  pluginName: NativePluginId,
  outcome: ProvisionOutcome,
): void {
  recordProvisionEvents(pluginName, outcome.actions);
  for (const action of outcome.actions) {
    log(pluginName, `provision: ${action}`);
  }
  for (const warning of outcome.warnings) {
    logWarn(pluginName, `provision: ${warning}`);
  }
  if (outcome.status === "failed" && outcome.error) {
    logError(pluginName, `provision failed: ${outcome.error}`);
  }
  const background = outcome.background;
  if (background) {
    void background()
      .then((result) =>
        reportProvision(pluginName, { ...result, background: undefined }),
      )
      .catch((err) =>
        logError(
          pluginName,
          `background provision: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }
}

/**
 * Provision every enabled native runtime (see native-runtimes.ts) and
 * return the outcomes so plugin construction can read what it got
 * (e.g. the installed version). A provisioner that throws is treated
 * as a failed pass, never a failed boot.
 */
async function provisionNativeRuntimes(
  config: TalonConfig,
): Promise<Map<NativePluginId, ProvisionOutcome>> {
  const outcomes = new Map<NativePluginId, ProvisionOutcome>();
  for (const runtime of NATIVE_RUNTIMES) {
    if (!runtime.enabled(config)) continue;
    try {
      const outcome = await runtime.provision(config);
      outcomes.set(runtime.id, outcome);
      reportProvision(runtime.id, outcome);
    } catch (err) {
      logError(
        runtime.id,
        `provision: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return outcomes;
}

/**
 * Load built-in plugins (GitHub, MemPalace, mem0, Playwright) based on config flags.
 * Shared by both bootstrap and hot-reload to avoid duplication.
 */
export async function loadBuiltinPlugins(config: TalonConfig): Promise<void> {
  const provisioned = await provisionNativeRuntimes(config);

  const github = config.github;
  if (github?.enabled) {
    try {
      const { createGitHubPlugin } =
        await import("../../plugins/github/index.js");
      const gh = createGitHubPlugin({
        token: github.token,
        imageTag: github.imageTag,
      });
      const ghConfig = github as unknown as Record<string, unknown>;
      const loaded = registerPlugin(gh, ghConfig);
      if (loaded) {
        await initPluginWithTimeout(
          loaded.plugin,
          loaded.config,
          15_000,
          "GitHub init",
          "GitHub init",
        );
      }
    } catch (err) {
      logError(
        "plugin",
        `GitHub init: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const mempalace = config.mempalace;
  if (mempalace?.enabled) {
    try {
      const { createMempalacePlugin } =
        await import("../../plugins/mempalace/index.js");
      const { resolveMempalacePaths } =
        await import("../../plugins/mempalace/provision.js");
      const { pythonPath, palacePath } = resolveMempalacePaths(mempalace);
      const mp = createMempalacePlugin({
        pythonPath,
        palacePath,
        entityLanguages: mempalace.entityLanguages,
        verbose: mempalace.verbose,
        installedVersion: provisioned.get("mempalace")?.version,
      });
      const mpConfig = mempalace as unknown as Record<string, unknown>;
      const loaded = registerPlugin(mp, mpConfig);
      if (loaded) {
        await initPluginWithTimeout(
          loaded.plugin,
          loaded.config,
          30_000,
          "MemPalace init",
          "MemPalace init",
        );
      }
    } catch (err) {
      logError(
        "plugin",
        `MemPalace init: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const mem0 = config.mem0;
  if (mem0?.enabled) {
    try {
      const { createMem0Plugin } = await import("../../plugins/mem0/index.js");
      const m0 = createMem0Plugin({
        apiKey: mem0.apiKey,
        host: mem0.host,
        userId: mem0.userId,
      });
      const m0Config = mem0 as unknown as Record<string, unknown>;
      const loaded = registerPlugin(m0, m0Config);
      if (loaded) {
        await initPluginWithTimeout(
          loaded.plugin,
          loaded.config,
          15_000,
          "mem0 init",
          "mem0 init",
        );
      }
    } catch (err) {
      logError(
        "plugin",
        `mem0 init: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const playwright = config.playwright;
  if (playwright?.enabled) {
    try {
      const { createPlaywrightPlugin } =
        await import("../../plugins/playwright/index.js");
      const pwConfig = playwright as unknown as Record<string, unknown>;
      const pw = createPlaywrightPlugin({
        browser: playwright.browser,
        headless: playwright.headless,
        endpoint: playwright.endpoint,
        endpointFile: playwright.endpointFile,
      });
      const loaded = registerPlugin(pw, pwConfig);
      if (loaded) {
        await initPluginWithTimeout(
          loaded.plugin,
          loaded.config,
          15_000,
          "Playwright init",
          "Playwright init",
        );
      }
    } catch (err) {
      logError(
        "plugin",
        `Playwright init: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

/**
 * Hot-reload all plugins: destroy current plugins, re-read config via the
 * validated loadConfig() path, re-load everything (external + built-in).
 * Returns the loaded plugin names and the config that was used.
 *
 * Throws on config parse/validation failure so the gateway can report an error.
 *
 * Does NOT restart the main process, Claude session, or bot connection. Active
 * conversations continue uninterrupted — new MCP servers spawn automatically
 * on the next tool call.
 */
export async function reloadPlugins(
  activeFrontends?: string[],
): Promise<{ names: string[]; config: TalonConfig }> {
  // Validate config BEFORE tearing down existing plugins. If the config is
  // malformed the error propagates and current plugins stay intact.
  const { loadConfig, getFrontends } = await import("../../util/config.js");
  const config = loadConfig();

  // Derive frontends from config if not explicitly provided
  const frontends = activeFrontends ?? getFrontends(config);

  // Bump reload timestamp so every MCP subprocess env differs from the previous
  // load — the Claude SDK will see a changed env and spawn fresh subprocesses,
  // picking up any source-file changes without a full Talon restart.
  reloadState.lastReloadAt = new Date().toISOString();

  // Config is valid — safe to destroy current plugins now
  log("plugin", "Hot-reload: destroying current plugins...");
  await registry.destroyAndClear();

  // Re-load external plugins
  if (config.plugins.length > 0) {
    await loadPlugins(config.plugins, frontends);
  }

  // Re-load built-in plugins using shared helper
  await loadBuiltinPlugins(config);

  // Retire the hub's MCP children: the next tool call (any chat) spawns
  // fresh processes from the reloaded registry, while in-flight calls
  // drain on the old ones (stdio-era behaviour was per-turn respawn via
  // the TALON_RELOAD_AT env bump; the hub owns lifecycles directly).
  const { reloadHubChildren } = await import("../mcp-hub/index.js");
  reloadHubChildren();

  const names = registry.all.map((p) => p.plugin.name);
  log(
    "plugin",
    `Hot-reload complete: ${names.length} plugins loaded [${names.join(", ")}]`,
  );

  return { names, config };
}
