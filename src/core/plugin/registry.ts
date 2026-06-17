/**
 * Plugin registry singleton + shared module state: the reload timestamp
 * (injected into MCP subprocess env) and the `_deps` indirection that lets
 * tests swap the module importer.
 *
 * Every plugin submodule imports the SAME `registry` instance and the SAME
 * `reloadState` / `_deps` holders from here so state stays coherent.
 */

import { logError, logWarn } from "../../util/log.js";
import type { LoadedPlugin, PluginMcpEntry } from "./types.js";

export class PluginRegistry {
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
export const registry = new PluginRegistry();

/**
 * Tracks the last reload timestamp. Injected into every MCP subprocess env as
 * TALON_RELOAD_AT so the Claude SDK sees a changed env on each reload and
 * spawns a fresh subprocess — picking up source-file changes without a full
 * Talon restart. On a holder object so other modules can read/update it.
 */
export const reloadState: { lastReloadAt: string } = {
  lastReloadAt: new Date().toISOString(),
};

/** Internal deps — exposed as an object so tests can replace properties.
 *  Direct function exports can't be mocked for internal callers in ESM. */
export const _deps = {
  importModule: async (path: string): Promise<Record<string, unknown>> =>
    import(path),
};
