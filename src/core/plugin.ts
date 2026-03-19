/**
 * Plugin system — load external tool plugins from local paths.
 *
 * Plugins provide:
 *   - An MCP server script (spawned as a subprocess alongside tools.ts)
 *   - Gateway action handlers (run in the main process)
 *   - Environment variable mappings for config → subprocess
 *
 * Plugin config in talon.json:
 *   "plugins": [
 *     { "path": "/path/to/plugin", "config": { ... } }
 *   ]
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { log, logError } from "../util/log.js";
import type { ActionResult } from "./types.js";

// ── Plugin interface ───────────────────────────────────────────────────────

/** What a plugin module must export (default export). */
export interface TalonPlugin {
  /** Unique plugin name (used as MCP server name). */
  name: string;

  /** Absolute path to the MCP server script (spawned as subprocess). */
  mcpServerPath: string;

  /**
   * Map plugin config to env vars passed to the MCP subprocess.
   * These env vars are also set on the main process for action handlers.
   */
  getEnvVars(config: Record<string, unknown>): Record<string, string>;

  /**
   * Handle a gateway action. Return null if the action is not recognized.
   * Same contract as handleSharedAction in gateway-actions.ts.
   */
  handleAction(
    body: Record<string, unknown>,
    chatId: string,
  ): Promise<ActionResult | null>;
}

/** A loaded plugin instance with its config. */
export interface LoadedPlugin {
  plugin: TalonPlugin;
  config: Record<string, unknown>;
  envVars: Record<string, string>;
}

// ── Plugin state ───────────────────────────────────────────────────────────

const loadedPlugins: LoadedPlugin[] = [];

// ── Loader ─────────────────────────────────────────────────────────────────

export async function loadPlugins(
  pluginConfigs: Array<{ path: string; config?: Record<string, unknown> }>,
): Promise<void> {
  for (const entry of pluginConfigs) {
    try {
      const pluginDir = resolve(entry.path);

      // Look for the plugin entry point
      const candidates = [
        resolve(pluginDir, "src", "index.ts"),
        resolve(pluginDir, "dist", "index.js"),
        resolve(pluginDir, "index.ts"),
        resolve(pluginDir, "index.js"),
      ];

      let entryPoint: string | null = null;
      for (const c of candidates) {
        if (existsSync(c)) { entryPoint = c; break; }
      }

      if (!entryPoint) {
        logError("plugin", `No entry point found in ${pluginDir}`);
        continue;
      }

      const mod = await import(entryPoint);
      const plugin: TalonPlugin = mod.default ?? mod;

      if (!plugin.name || !plugin.mcpServerPath || !plugin.handleAction) {
        logError("plugin", `Invalid plugin at ${pluginDir}: missing name, mcpServerPath, or handleAction`);
        continue;
      }

      const config = entry.config ?? {};
      const envVars = plugin.getEnvVars(config);

      // Set env vars on main process so action handlers can read them
      for (const [k, v] of Object.entries(envVars)) {
        process.env[k] = v;
      }

      loadedPlugins.push({ plugin, config, envVars });
      log("plugin", `Loaded: ${plugin.name} from ${pluginDir}`);
    } catch (err) {
      logError("plugin", `Failed to load plugin at ${entry.path}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── Accessors ──────────────────────────────────────────────────────────────

export function getLoadedPlugins(): readonly LoadedPlugin[] {
  return loadedPlugins;
}

/**
 * Try all loaded plugins for an action. Returns the first non-null result.
 * Called by the gateway after shared actions but before frontend handlers.
 */
export async function handlePluginAction(
  body: Record<string, unknown>,
  chatId: string,
): Promise<ActionResult | null> {
  for (const { plugin } of loadedPlugins) {
    try {
      const result = await plugin.handleAction(body, chatId);
      if (result) return result;
    } catch (err) {
      logError("plugin", `${plugin.name} action error: ${err instanceof Error ? err.message : err}`);
      return { ok: false, error: `Plugin ${plugin.name}: ${err instanceof Error ? err.message : err}` };
    }
  }
  return null;
}

/**
 * Build the mcpServers entries for all loaded plugins.
 * Called by the backend when constructing query options.
 */
export function getPluginMcpServers(
  bridgeUrl: string,
  chatId: string,
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};

  for (const { plugin, envVars } of loadedPlugins) {
    servers[`${plugin.name}-tools`] = {
      command: process.platform === "win32" ? "npx" : "node",
      args: process.platform === "win32"
        ? ["tsx", plugin.mcpServerPath]
        : ["--import", "tsx", plugin.mcpServerPath],
      env: {
        TALON_BRIDGE_URL: bridgeUrl,
        TALON_CHAT_ID: chatId,
        ...envVars,
      },
    };
  }

  return servers;
}
