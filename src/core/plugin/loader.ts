/**
 * Plugin loader — resolve entry points, import + validate plugin modules,
 * register instances, run init hooks with a timeout, and the public
 * load/register/query/destroy helpers.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { log, logError } from "../../util/log.js";
import type {
  LoadedPlugin,
  PluginEntry,
  PluginPathEntry,
  TalonPlugin,
} from "./types.js";
import { isMcpPlugin } from "./types.js";
import { registry, _deps } from "./registry.js";
import { GATEWAY_TOKEN_ENV } from "../engine/gateway-auth.js";

/**
 * Candidate entry point paths, checked in order. Exported for
 * `talon plugin install`, which verifies a module before adding it.
 */
export const ENTRY_CANDIDATES = [
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
    // Disabled entries stay in config (so `talon plugin enable` can restore
    // them) but are never loaded or registered.
    if (entry.enabled === false) {
      log(
        "plugin",
        `Skipped disabled plugin: ${isMcpPlugin(entry) ? entry.name : entry.path}`,
      );
      continue;
    }
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
    // The gateway token is the daemon's own credential; a plugin may read
    // it but never replace it.
    if (key === GATEWAY_TOKEN_ENV) continue;
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

export async function initPluginWithTimeout(
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

async function loadSinglePlugin(
  entry: PluginPathEntry,
  activeFrontends?: string[],
): Promise<void> {
  const pluginDir = resolve(entry.path);

  const entryPoint = resolveEntryPoint(pluginDir);
  if (!entryPoint) {
    logError(
      "plugin",
      `No entry point found in ${pluginDir} (tried: ${ENTRY_CANDIDATES.join(", ")})`,
    );
    return;
  }

  const mod = await _deps.importModule(entryPoint);
  const plugin = extractPlugin(mod);
  if (!plugin) {
    logError(
      "plugin",
      `Invalid plugin at ${pluginDir}: must export an object with a "name" property`,
    );
    return;
  }

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

  await initPluginWithTimeout(
    loaded.plugin,
    loaded.config,
    30_000,
    "init",
    `Plugin "${loaded.plugin.name}" init failed`,
  );

  log("plugin", `Loaded: ${describePlugin(loaded.plugin)}`);
}

/** `name v1.0 — description`, for load/register log lines. */
function describePlugin(plugin: TalonPlugin): string {
  const version = plugin.version ? ` v${plugin.version}` : "";
  const desc = plugin.description ? ` — ${plugin.description}` : "";
  return `${plugin.name}${version}${desc}`;
}

function resolveEntryPoint(pluginDir: string): string | null {
  for (const candidate of ENTRY_CANDIDATES) {
    const full = resolve(pluginDir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function extractPlugin(mod: Record<string, unknown>): TalonPlugin | null {
  // `export default { … }` or `module.exports = { … }`
  const candidate = mod.default ?? mod;
  if (!candidate || typeof candidate !== "object") return null;
  const plugin = candidate as Record<string, unknown>;
  if (typeof plugin.name !== "string" || !plugin.name) return null;
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

export function getLoadedPlugins(): readonly LoadedPlugin[] {
  return registry.all;
}

export function getPlugin(name: string): LoadedPlugin | undefined {
  return registry.getByName(name);
}

export function getPluginCount(): number {
  return registry.count;
}

/** Shutdown path. */
export async function destroyPlugins(): Promise<void> {
  await registry.destroyAll();
}

/**
 * Register a built-in plugin (configured by its own config section, not a
 * `plugins[]` entry) without the filesystem loader. Does NOT call `init()`;
 * the caller does.
 */
export function registerPlugin(
  plugin: TalonPlugin,
  config: Record<string, unknown> = {},
): LoadedPlugin | null {
  const loaded = registerPluginInstance(plugin, config, "(built-in)");
  if (!loaded) return null;
  log("plugin", `Registered built-in: ${describePlugin(loaded.plugin)}`);
  return loaded;
}

/** Every plugin's trimmed system-prompt addition, load order. */
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
