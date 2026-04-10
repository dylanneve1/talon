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
import type { ActionResult } from "./types.js";

// ── Plugin interfaces ──────────────────────────────────────────────────────

/** Configuration entry for a plugin in talon.json. */
export interface PluginEntry {
  path: string;
  config?: Record<string, unknown>;
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

  get all(): readonly LoadedPlugin[] {
    return this.plugins;
  }

  get count(): number {
    return this.plugins.length;
  }

  register(loaded: LoadedPlugin): void {
    // Guard against duplicate names
    const existing = this.plugins.find(
      (p) => p.plugin.name === loaded.plugin.name,
    );
    if (existing) {
      logWarn(
        "plugin",
        `Duplicate plugin name "${loaded.plugin.name}" — skipping (already loaded from ${existing.path})`,
      );
      return;
    }
    this.plugins.push(loaded);
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
}

// Module-level singleton
const registry = new PluginRegistry();

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

async function loadSinglePlugin(
  entry: PluginEntry,
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

  // Validate config if the plugin provides validation
  const errors = plugin.validateConfig?.(config);
  if (errors && errors.length > 0) {
    logError(
      "plugin",
      `Plugin "${plugin.name}" config validation failed:\n  ${errors.join("\n  ")}`,
    );
    return;
  }

  // Resolve env vars
  const envVars = plugin.getEnvVars?.(config) ?? {};

  // Set env vars on main process for action handlers
  for (const [k, v] of Object.entries(envVars)) {
    process.env[k] = v;
  }

  // Register before init (so other plugins can discover it)
  const loaded: LoadedPlugin = { plugin, config, envVars, path: pluginDir };
  registry.register(loaded);

  // Run init hook
  const INIT_TIMEOUT = 30_000;
  try {
    await Promise.race([
      plugin.init?.(config),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("init timeout (30s)")), INIT_TIMEOUT),
      ),
    ]);
  } catch (err) {
    logError(
      "plugin",
      `Plugin "${plugin.name}" init failed: ${err instanceof Error ? err.message : err}`,
    );
    // Still registered — tools may work even if init partially failed
  }

  const version = plugin.version ? ` v${plugin.version}` : "";
  const desc = plugin.description ? ` — ${plugin.description}` : "";
  log("plugin", `Loaded: ${plugin.name}${version}${desc}`);
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
): void {
  // Check for duplicates first — avoids re-running expensive validation
  if (registry.getByName(plugin.name)) {
    logWarn(
      "plugin",
      `Built-in plugin "${plugin.name}" already registered — skipping`,
    );
    return;
  }

  const errors = plugin.validateConfig?.(config);
  if (errors && errors.length > 0) {
    logError(
      "plugin",
      `Built-in plugin "${plugin.name}" config validation failed:\n  ${errors.join("\n  ")}`,
    );
    return;
  }

  const envVars = plugin.getEnvVars?.(config) ?? {};
  for (const [k, v] of Object.entries(envVars)) {
    process.env[k] = v;
  }
  const loaded: LoadedPlugin = { plugin, config, envVars, path: "(built-in)" };
  registry.register(loaded);

  const version = plugin.version ? ` v${plugin.version}` : "";
  const desc = plugin.description ? ` — ${plugin.description}` : "";
  log("plugin", `Registered built-in: ${plugin.name}${version}${desc}`);
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
    const baseEnv = {
      TALON_BRIDGE_URL: bridgeUrl,
      TALON_CHAT_ID: chatId,
      ...envVars,
    };

    if (plugin.mcpServer) {
      // Custom command/args (Python, Go, etc.) — no tsx wrapper
      servers[`${plugin.name}-tools`] = {
        command: plugin.mcpServer.command,
        args: [...plugin.mcpServer.args],
        env: baseEnv,
      };
    } else if (plugin.mcpServerPath) {
      // Existing Node/tsx pattern
      servers[`${plugin.name}-tools`] = {
        command: process.platform === "win32" ? "npx" : "node",
        args:
          process.platform === "win32"
            ? ["tsx", plugin.mcpServerPath]
            : ["--import", tsxPath, plugin.mcpServerPath],
        env: baseEnv,
      };
    }
  }

  return servers;
}
