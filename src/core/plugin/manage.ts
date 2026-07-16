/**
 * Plugin management over the live config — list and toggle, outcomes as
 * data. The client bridge's plugin endpoints run through here in-process;
 * the CLI edits config.json out-of-process with the same `entries.ts`
 * helpers and converges through `POST /plugins/reload`. Rendering (and
 * persisting/hot-applying, which are surface concerns) stay with the
 * caller: a toggle returns the exact partial document to merge into
 * talon.json so the surface owns its own write path.
 */

import type { TalonConfig } from "../../util/config.js";
import { isPathPlugin, type PluginEntry } from "./types.js";
import {
  BUILTIN_PLUGINS,
  entryDisplayName,
  findEntryIndex,
  isBuiltinPlugin,
  withEnabled,
} from "./entries.js";

/** One plugin as every management surface lists it. */
export type PluginItem = {
  readonly name: string;
  readonly kind: "builtin" | "module" | "mcp";
  readonly enabled: boolean;
  /** Where it comes from: a config section, module path, or MCP command. */
  readonly source: string;
};

export type PluginToggleOutcome =
  | {
      readonly ok: true;
      readonly name: string;
      /** Partial talon.json document the surface must persist. */
      readonly persist: Record<string, unknown>;
    }
  | { readonly ok: false; readonly error: string };

function builtinSection(
  config: TalonConfig,
  name: string,
): { enabled?: boolean } | undefined {
  return (config as unknown as Record<string, { enabled?: boolean }>)[name];
}

/** Every plugin: built-ins first, then configured entries, config order. */
export function listPluginItems(config: TalonConfig): PluginItem[] {
  const builtins: PluginItem[] = BUILTIN_PLUGINS.map((name) => ({
    name,
    kind: "builtin" as const,
    enabled: builtinSection(config, name)?.enabled === true,
    source: `config.${name}`,
  }));
  const configured: PluginItem[] = (config.plugins ?? []).map((entry) => ({
    name: entryDisplayName(entry),
    kind: isPathPlugin(entry) ? ("module" as const) : ("mcp" as const),
    enabled: entry.enabled !== false,
    source: isPathPlugin(entry)
      ? entry.path
      : `${entry.command}${entry.args ? ` ${entry.args.join(" ")}` : ""}`,
  }));
  return [...builtins, ...configured];
}

/**
 * Toggle a plugin on the LIVE config object (so in-process readers see the
 * change immediately) and report what to persist. Hot-applying (plugin
 * reload, prompt rebuild) is the caller's follow-up — this function only
 * decides and mutates state.
 */
export function setPluginEnabled(
  config: TalonConfig,
  rawName: string,
  enabled: boolean,
): PluginToggleOutcome {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "A plugin name is required." };

  if (isBuiltinPlugin(name)) {
    const section = { ...(builtinSection(config, name) ?? {}), enabled };
    (config as unknown as Record<string, unknown>)[name] = section;
    return { ok: true, name, persist: { [name]: section } };
  }

  const list: PluginEntry[] = config.plugins ?? [];
  const index = findEntryIndex(list, name);
  if (index < 0) {
    return { ok: false, error: `No plugin named "${name}".` };
  }
  // withEnabled only adds/drops the `enabled` key, so the entry keeps its
  // (validated) format — safe to narrow back from the JSON helper shape.
  list[index] = withEnabled(list[index]!, enabled) as PluginEntry;
  config.plugins = list;
  return {
    ok: true,
    name: entryDisplayName(list[index]!),
    persist: { plugins: list },
  };
}
