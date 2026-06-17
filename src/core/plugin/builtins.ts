/**
 * Built-in plugin loading (GitHub / MemPalace / Playwright) + the hot-reload
 * path that re-reads config, tears down, and re-loads everything.
 */

import { log, logError } from "../../util/log.js";
import type { TalonConfig } from "../../util/config.js";
import { registry, reloadState } from "./registry.js";
import {
  initPluginWithTimeout,
  loadPlugins,
  registerPlugin,
} from "./loader.js";

/**
 * Load built-in plugins (GitHub, MemPalace, Playwright) based on config flags.
 * Shared by both bootstrap and hot-reload to avoid duplication.
 */
export async function loadBuiltinPlugins(config: TalonConfig): Promise<void> {
  const github = config.github;
  if (github?.enabled) {
    try {
      const { createGitHubPlugin } =
        await import("../../plugins/github/index.js");
      const gh = createGitHubPlugin({ token: github.token });
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
      const { dirs, files: pf } = await import("../../util/paths.js");
      const pythonPath = mempalace.pythonPath ?? pf.mempalacePython;
      const palacePath = mempalace.palacePath ?? dirs.palace;
      const mp = createMempalacePlugin({
        pythonPath,
        palacePath,
        entityLanguages: mempalace.entityLanguages,
        verbose: mempalace.verbose,
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

  const names = registry.all.map((p) => p.plugin.name);
  log(
    "plugin",
    `Hot-reload complete: ${names.length} plugins loaded [${names.join(", ")}]`,
  );

  return { names, config };
}
