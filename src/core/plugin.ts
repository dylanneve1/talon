/**
 * Plugin system — extensible tool integration for Talon.
 *
 * Design principles:
 *   - Interface Segregation: plugins implement only what they need
 *   - Open/Closed: lifecycle hooks allow extension without core changes
 *   - Dependency Inversion: plugins receive config, don't depend on globals
 *   - Single Responsibility: loader, registry, and routing are separated
 *   - Error Isolation: one plugin failing doesn't take down others
 *
 * Plugin config in talon.json:
 *   "plugins": [
 *     { "path": "/path/to/plugin", "config": { ... } }
 *   ]
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { log, logError, logWarn } from "../util/log.js";
import { wrapMcpServer } from "../util/mcp-launcher.js";
import type { ActionResult } from "./types.js";
import type { TalonConfig } from "../util/config.js";

// ── Plugin interfaces ──────────────────────────────────────────────────────

/** Path-based plugin entry (loaded as a Node module). */
export interface PluginPathEntry {
  path: string;
  config?: Record<string, unknown>;
}

/** Standalone MCP server entry (command + args, not a loadable module). */
export interface PluginMcpEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Configuration entry for a plugin in config.json. */
export type PluginEntry = PluginPathEntry | PluginMcpEntry;

/** Type guard: is this a path-based plugin? */
export function isPathPlugin(entry: PluginEntry): entry is PluginPathEntry {
  return "path" in entry;
}

/** Type guard: is this a standalone MCP server entry? */
export function isMcpPlugin(entry: PluginEntry): entry is PluginMcpEntry {
  return "command" in entry && "name" in entry && !("path" in entry);
}

/**
 * Core plugin interface — only `name` is required.
 * All other capabilities are optional (Interface Segregation).
 */
export interface TalonPlugin {
  /** Unique plugin identifier. Used as MCP server name prefix. */
  readonly name: string;

  /** Human-readable description for status/diagnostics. */
  readonly description?: string;

  /** Semver version string. */
  readonly version?: string;

  /**
   * Frontend whitelist — which frontends this plugin is active for.
   * If unset, the plugin is available on all frontends.
   * Example: ["telegram"] — only loads when Telegram frontend is active.
   */
  readonly frontends?: readonly string[];

  /**
   * Called once after the plugin is loaded and validated.
   * Use for one-time setup (connections, caches, etc).
   * Receives the resolved plugin config.
   */
  init?(config: Record<string, unknown>): Promise<void> | void;

  /**
   * Called during graceful shutdown. Clean up resources.
   */
  destroy?(): Promise<void> | void;

  /**
   * Absolute path to the MCP server script (spawned as subprocess via node/tsx).
   * Omit if the plugin only provides action handlers without MCP tools.
   * For non-Node MCP servers (Python, Go, etc.), use `mcpServer` instead.
   */
  mcpServerPath?: string;

  /**
   * Custom MCP server command and arguments (e.g. Python, Go, Rust servers).
   * Takes priority over `mcpServerPath` when both are set.
   * Example: { command: "/path/to/python", args: ["-m", "mempalace.mcp_server"] }
   */
  mcpServer?: {
    readonly command: string;
    readonly args: readonly string[];
  };

  /**
   * Map plugin config to env vars for the MCP subprocess and action handlers.
   * Called once at load time. Values are set on process.env for the main
   * process and passed to the MCP subprocess.
   */
  getEnvVars?(config: Record<string, unknown>): Record<string, string>;

  /**
   * Handle a gateway action. Return null if not recognized.
   * Actions are tried in plugin load order, first non-null wins.
   */
  handleAction?(
    body: Record<string, unknown>,
    chatId: string,
  ): Promise<ActionResult | null>;

  /**
   * Contribute additional context to the system prompt.
   * Called during config loading. Return text to append.
   */
  getSystemPromptAddition?(config: Record<string, unknown>): string;

  /**
   * Validate plugin config at load time.
   * Return an array of error messages, or empty/undefined if valid.
   */
  validateConfig?(config: Record<string, unknown>): string[] | undefined;
}

// ── Plugin registry ────────────────────────────────────────────────────────

/** A loaded and validated plugin instance with its resolved config. */
export interface LoadedPlugin {
  readonly plugin: TalonPlugin;
  readonly config: Record<string, unknown>;
  readonly envVars: Record<string, string>;
  readonly path: string;
}

class PluginRegistry {
  private readonly plugins: LoadedPlugin[] = [];
  private readonly standaloneMcpServers: PluginMcpEntry[] = [];

  get all(): readonly LoadedPlugin[] {
    return this.plugins;
  }

  get mcpEntries(): readonly PluginMcpEntry[] {
    return this.standaloneMcpServers;
  }

  get count(): number {
    return this.plugins.length;
  }

  private getRegistrationSource(name: string): string | undefined {
    const existingPlugin = this.plugins.find(
      (entry) => entry.plugin.name === name,
    );
    if (existingPlugin) return existingPlugin.path;

    const existingMcpEntry = this.standaloneMcpServers.find(
      (entry) => entry.name === name,
    );
    if (existingMcpEntry) return "standalone MCP entry";

    return undefined;
  }

  register(loaded: LoadedPlugin): boolean {
    const existingSource = this.getRegistrationSource(loaded.plugin.name);
    if (existingSource) {
      logWarn(
        "plugin",
        `Duplicate plugin/MCP name "${loaded.plugin.name}" — skipping (already registered from ${existingSource})`,
      );
      return false;
    }
    this.plugins.push(loaded);
    return true;
  }

  registerMcpEntry(entry: PluginMcpEntry): boolean {
    const existingSource = this.getRegistrationSource(entry.name);
    if (existingSource) {
      logWarn(
        "plugin",
        `Duplicate plugin/MCP name "${entry.name}" — skipping (already registered from ${existingSource})`,
      );
      return false;
    }
    this.standaloneMcpServers.push(entry);
    return true;
  }

  getByName(name: string): LoadedPlugin | undefined {
    return this.plugins.find((p) => p.plugin.name === name);
  }

  async destroyAll(): Promise<void> {
    for (const { plugin } of this.plugins) {
      try {
        await plugin.destroy?.();
      } catch (err) {
        logError(
          "plugin",
          `${plugin.name} destroy error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /** Destroy all plugins, clean up env vars, and clear the registry. Used by hot-reload. */
  async destroyAndClear(): Promise<void> {
    // Clean up env vars set by plugins before destroying
    for (const { envVars } of this.plugins) {
      for (const key of Object.keys(envVars)) {
        delete process.env[key];
      }
    }
    await this.destroyAll();
    this.plugins.length = 0;
    this.standaloneMcpServers.length = 0;
  }
}

// Module-level singleton
const registry = new PluginRegistry();

/**
 * Tracks the last reload timestamp. Injected into every MCP subprocess env
 * as TALON_RELOAD_AT so the Claude SDK sees a changed env on each reload and
 * spawns a fresh subprocess — ensuring source-file changes are picked up
 * without a full Talon restart.
 */
let _lastReloadAt: string = new Date().toISOString();

/** Internal deps — exposed as an object so tests can replace properties.
 *  Direct function exports can't be mocked for internal callers in ESM. */
export const _deps = {
  importModule: async (path: string): Promise<Record<string, unknown>> =>
    import(path),
};

// ── Loader ─────────────────────────────────────────────────────────────────

/** Candidate entry point paths, checked in order. */
const ENTRY_CANDIDATES = [
  "src/index.ts",
  "dist/index.js",
  "index.ts",
  "index.js",
];

/**
 * Load and validate plugins from config entries.
 * Plugins that fail to load are logged and skipped — they don't block others.
 * @param activeFrontends — currently active frontends (e.g. ["terminal"]). Plugins
 *   with a `frontends` whitelist are skipped if none match.
 */
export async function loadPlugins(
  pluginConfigs: PluginEntry[],
  activeFrontends?: string[],
): Promise<void> {
  for (const entry of pluginConfigs) {
    // Standalone MCP servers are registered for getPluginMcpServers, not loaded as modules
    if (isMcpPlugin(entry)) {
      if (registry.registerMcpEntry(entry)) {
        log("plugin", `Registered standalone MCP server: ${entry.name}`);
      }
      continue;
    }
    try {
      await loadSinglePlugin(entry, activeFrontends);
    } catch (err) {
      logError(
        "plugin",
        `Failed to load plugin at ${entry.path}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

function applyEnvVars(envVars: Record<string, string>): void {
  for (const [key, value] of Object.entries(envVars)) {
    process.env[key] = value;
  }
}

function registerPluginInstance(
  plugin: TalonPlugin,
  config: Record<string, unknown>,
  path: string,
): LoadedPlugin | null {
  const errors = plugin.validateConfig?.(config);
  if (errors && errors.length > 0) {
    logError(
      "plugin",
      `${path === "(built-in)" ? `Built-in plugin "${plugin.name}"` : `Plugin "${plugin.name}"`} config validation failed:\n  ${errors.join("\n  ")}`,
    );
    return null;
  }

  const envVars = plugin.getEnvVars?.(config) ?? {};
  const loaded: LoadedPlugin = { plugin, config, envVars, path };
  if (!registry.register(loaded)) return null;

  applyEnvVars(envVars);
  return loaded;
}

async function initPluginWithTimeout(
  plugin: TalonPlugin,
  config: Record<string, unknown>,
  timeoutMs: number,
  timeoutLabel: string,
  errorPrefix: string,
): Promise<void> {
  if (!plugin.init) return;

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.resolve(plugin.init(config)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(`${timeoutLabel} timed out after ${timeoutMs / 1000}s`),
          );
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    logError(
      "plugin",
      `${errorPrefix}: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildBridgeEnv(
  bridgeUrl: string,
  chatId: string,
  envVars?: Record<string, string>,
): Record<string, string> {
  return {
    ...envVars,
    TALON_BRIDGE_URL: bridgeUrl,
    TALON_CHAT_ID: chatId,
    TALON_RELOAD_AT: _lastReloadAt,
  };
}

async function loadSinglePlugin(
  entry: PluginPathEntry,
  activeFrontends?: string[],
): Promise<void> {
  const pluginDir = resolve(entry.path);

  // Resolve entry point
  const entryPoint = resolveEntryPoint(pluginDir);
  if (!entryPoint) {
    logError(
      "plugin",
      `No entry point found in ${pluginDir} (tried: ${ENTRY_CANDIDATES.join(", ")})`,
    );
    return;
  }

  // Import and extract plugin module
  const mod = await _deps.importModule(entryPoint);
  const plugin = extractPlugin(mod);
  if (!plugin) {
    logError(
      "plugin",
      `Invalid plugin at ${pluginDir}: must export an object with a "name" property`,
    );
    return;
  }

  // Check frontend whitelist — skip if plugin specifies frontends and none match
  if (plugin.frontends && plugin.frontends.length > 0 && activeFrontends) {
    const match = activeFrontends.some((fe) => plugin.frontends!.includes(fe));
    if (!match) {
      log(
        "plugin",
        `Skipped: ${plugin.name} (requires ${plugin.frontends.join("/")} frontend)`,
      );
      return;
    }
  }

  const config = entry.config ?? {};
  const loaded = registerPluginInstance(plugin, config, pluginDir);
  if (!loaded) return;

  // Run init hook
  await initPluginWithTimeout(
    loaded.plugin,
    loaded.config,
    30_000,
    "init",
    `Plugin "${loaded.plugin.name}" init failed`,
  );

  const version = loaded.plugin.version ? ` v${loaded.plugin.version}` : "";
  const desc = loaded.plugin.description
    ? ` — ${loaded.plugin.description}`
    : "";
  log("plugin", `Loaded: ${loaded.plugin.name}${version}${desc}`);
}

function resolveEntryPoint(pluginDir: string): string | null {
  for (const candidate of ENTRY_CANDIDATES) {
    const full = resolve(pluginDir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function extractPlugin(mod: Record<string, unknown>): TalonPlugin | null {
  // Support: export default { ... } or module.exports = { ... }
  const candidate = mod.default ?? mod;
  if (!candidate || typeof candidate !== "object") return null;
  const plugin = candidate as Record<string, unknown>;
  // Validate required field types
  if (typeof plugin.name !== "string" || !plugin.name) return null;
  // Validate optional fields are the right types if present
  if (
    plugin.handleAction !== undefined &&
    typeof plugin.handleAction !== "function"
  )
    return null;
  if (plugin.init !== undefined && typeof plugin.init !== "function")
    return null;
  if (
    plugin.getSystemPromptAddition !== undefined &&
    typeof plugin.getSystemPromptAddition !== "function"
  )
    return null;
  if (
    plugin.mcpServerPath !== undefined &&
    typeof plugin.mcpServerPath !== "string"
  )
    return null;
  if (plugin.mcpServer !== undefined) {
    if (typeof plugin.mcpServer !== "object" || plugin.mcpServer === null)
      return null;
    const srv = plugin.mcpServer as Record<string, unknown>;
    if (
      typeof srv.command !== "string" ||
      !srv.command ||
      !Array.isArray(srv.args) ||
      !srv.args.every((a) => typeof a === "string")
    )
      return null;
  }
  if (plugin.frontends !== undefined && !Array.isArray(plugin.frontends))
    return null;
  return candidate as TalonPlugin;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Get all loaded plugins. */
export function getLoadedPlugins(): readonly LoadedPlugin[] {
  return registry.all;
}

/** Get a plugin by name. */
export function getPlugin(name: string): LoadedPlugin | undefined {
  return registry.getByName(name);
}

/** Number of loaded plugins. */
export function getPluginCount(): number {
  return registry.count;
}

/** Destroy all plugins (called during shutdown). */
export async function destroyPlugins(): Promise<void> {
  await registry.destroyAll();
}

/**
 * Load built-in plugins (GitHub, MemPalace, Playwright) based on config flags.
 * Shared by both bootstrap and hot-reload to avoid duplication.
 */
export async function loadBuiltinPlugins(config: TalonConfig): Promise<void> {
  const github = config.github;
  if (github?.enabled) {
    try {
      const { createGitHubPlugin } = await import("../plugins/github/index.js");
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
        await import("../plugins/mempalace/index.js");
      const { dirs, files: pf } = await import("../util/paths.js");
      const pythonPath = mempalace.pythonPath ?? pf.mempalacePython;
      const palacePath = mempalace.palacePath ?? dirs.palace;
      const mp = createMempalacePlugin({
        pythonPath,
        palacePath,
        entityLanguages: mempalace.entityLanguages,
        verbose: mempalace.verbose,
        autoInstall: mempalace.autoInstall,
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
        await import("../plugins/playwright/index.js");
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
 * Hot-reload all plugins: destroy current plugins, re-read config via
 * the validated loadConfig() path, re-load everything (external + built-in).
 * Returns the loaded plugin names and the config that was used.
 *
 * Throws on config parse/validation failure so the gateway can report an error.
 *
 * Does NOT restart the main process, Claude session, or bot connection.
 * Active conversations continue uninterrupted — new MCP servers spawn
 * automatically on the next tool call.
 */
export async function reloadPlugins(
  activeFrontends?: string[],
): Promise<{ names: string[]; config: TalonConfig }> {
  // Validate config BEFORE tearing down existing plugins.
  // If the config is malformed the error propagates and current plugins stay intact.
  const { loadConfig, getFrontends } = await import("../util/config.js");
  const config = loadConfig();

  // Derive frontends from config if not explicitly provided
  const frontends = activeFrontends ?? getFrontends(config);

  // Bump reload timestamp so every MCP subprocess env differs from the previous
  // load — the Claude SDK will see a changed env and spawn fresh subprocesses,
  // picking up any source-file changes without a full Talon restart.
  _lastReloadAt = new Date().toISOString();

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

/**
 * Register a built-in plugin directly (bypasses filesystem loader).
 * Used for tightly-integrated plugins like mempalace that are configured
 * via dedicated config fields rather than the plugins[] array.
 *
 * NOTE: This only registers the plugin — it does NOT call `init()`.
 * The caller is responsible for calling `plugin.init()` separately
 * after registration if initialization is needed.
 */
export function registerPlugin(
  plugin: TalonPlugin,
  config: Record<string, unknown> = {},
): LoadedPlugin | null {
  const loaded = registerPluginInstance(plugin, config, "(built-in)");
  if (!loaded) return null;

  const version = loaded.plugin.version ? ` v${loaded.plugin.version}` : "";
  const desc = loaded.plugin.description
    ? ` — ${loaded.plugin.description}`
    : "";
  log("plugin", `Registered built-in: ${loaded.plugin.name}${version}${desc}`);
  return loaded;
}

/**
 * Collect system prompt additions from all plugins.
 * Called during config/prompt assembly.
 */
export function getPluginPromptAdditions(): string[] {
  const additions: string[] = [];
  for (const { plugin, config } of registry.all) {
    try {
      const addition = plugin.getSystemPromptAddition?.(config);
      if (addition?.trim()) additions.push(addition.trim());
    } catch (err) {
      logError(
        "plugin",
        `${plugin.name} prompt addition error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return additions;
}

// ── Action routing ─────────────────────────────────────────────────────────

/**
 * Route an action through all loaded plugins.
 * Returns the first non-null result. Errors from individual plugins
 * are caught and returned as error results — they don't cascade.
 */
export async function handlePluginAction(
  body: Record<string, unknown>,
  chatId: string,
): Promise<ActionResult | null> {
  for (const { plugin } of registry.all) {
    if (!plugin.handleAction) continue;
    try {
      const result = await plugin.handleAction(body, chatId);
      if (result) return result;
    } catch (err) {
      logError(
        "plugin",
        `${plugin.name} action error: ${err instanceof Error ? err.message : err}`,
      );
      return {
        ok: false,
        error: `Plugin ${plugin.name}: ${err instanceof Error ? err.message : err}`,
      };
    }
  }
  return null;
}

// ── MCP server config ──────────────────────────────────────────────────────

/** MCP server configuration for the Claude Agent SDK. */
export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build MCP server entries for plugins that provide an MCP server.
 * Plugins can expose an MCP server in two ways:
 *   - `mcpServerPath` — path to a Node/TypeScript MCP server script (run via tsx)
 *   - `mcpServer` — custom command/args for non-Node servers (Python, Go, etc.)
 * Plugins with neither are skipped. When both are set, `mcpServer` takes priority.
 *
 * @param only — optional list of plugin names to include. If omitted, all
 *   plugins with MCP servers are returned. Pass `[]` to get none.
 */
export function getPluginMcpServers(
  bridgeUrl: string,
  chatId: string,
  only?: string[],
): Record<string, McpServerConfig> {
  if (only !== undefined && only.length === 0) return {};

  const servers: Record<string, McpServerConfig> = {};

  // Resolve tsx from Talon's own node_modules (not cwd which may be ~/.talon/workspace/)
  const tsxPath = resolve(
    import.meta.dirname,
    "../../node_modules/tsx/dist/esm/index.mjs",
  );

  for (const { plugin, envVars } of registry.all) {
    // Skip plugins not in the allow-list when filtering
    if (only !== undefined && !only.includes(plugin.name)) continue;
    const baseEnv = buildBridgeEnv(bridgeUrl, chatId, envVars);

    if (plugin.mcpServer) {
      // Custom command/args (Python, Go, etc.) — no tsx wrapper
      servers[`${plugin.name}-tools`] = wrapMcpServer({
        command: plugin.mcpServer.command,
        args: [...plugin.mcpServer.args],
        env: baseEnv,
      });
    } else if (plugin.mcpServerPath) {
      // Existing Node/tsx pattern
      servers[`${plugin.name}-tools`] = wrapMcpServer({
        command: process.platform === "win32" ? "npx" : "node",
        args:
          process.platform === "win32"
            ? ["tsx", plugin.mcpServerPath]
            : ["--import", tsxPath, plugin.mcpServerPath],
        env: baseEnv,
      });
    }
  }

  // Include standalone MCP server entries from config
  for (const entry of registry.mcpEntries) {
    if (only !== undefined && !only.includes(entry.name)) continue;
    servers[`${entry.name}-tools`] = wrapMcpServer({
      command: entry.command,
      args: [...(entry.args ?? [])],
      env: buildBridgeEnv(bridgeUrl, chatId, entry.env),
    });
  }

  return servers;
}
