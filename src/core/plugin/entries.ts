/**
 * Pure helpers over the config `plugins` array, shared by every surface
 * that lists or toggles plugins (the `talon plugin` command group, the
 * client bridge's plugin endpoints). Entries here are the on-disk shape
 * (`core/plugin/types.ts` PluginEntry), not loaded plugins. No filesystem
 * or process access — everything is testable data-in/data-out.
 */

/** On-disk plugin entry — path-based module or standalone MCP server. */
export type PluginEntryJson = {
  path?: string;
  config?: Record<string, unknown>;
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

/**
 * Built-in plugins toggled by their own config sections (`github.enabled`,
 * …) rather than `plugins[]` entries — see core/plugin/builtins.ts.
 */
export const BUILTIN_PLUGINS = [
  "github",
  "mempalace",
  "mem0",
  "playwright",
] as const;

export function isBuiltinPlugin(name: string): boolean {
  return (BUILTIN_PLUGINS as readonly string[]).includes(name);
}

/** Split a config path on either separator — Windows configs carry `\`. */
function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * Display name for an entry: the MCP name, or for path entries the package
 * name — segments after the last `node_modules` (preserving `@scope/pkg`),
 * else the folder basename.
 */
export function entryDisplayName(entry: PluginEntryJson): string {
  if (entry.name) return entry.name;
  if (!entry.path) return "(invalid entry)";
  const segments = pathSegments(entry.path);
  const nm = segments.lastIndexOf("node_modules");
  if (nm >= 0 && nm < segments.length - 1) {
    return segments.slice(nm + 1).join("/");
  }
  return segments[segments.length - 1] ?? entry.path;
}

/** Does `token` identify this entry? Display name, basename, or full path. */
export function entryMatches(entry: PluginEntryJson, token: string): boolean {
  if (entryDisplayName(entry) === token) return true;
  if (!entry.path) return false;
  const segments = pathSegments(entry.path);
  return entry.path === token || segments[segments.length - 1] === token;
}

export function findEntryIndex(
  entries: readonly PluginEntryJson[],
  token: string,
): number {
  return entries.findIndex((entry) => entryMatches(entry, token));
}

/**
 * Index of an entry with the same identity as `candidate` (same module
 * path or same MCP name) — the duplicate an install must replace.
 */
export function findConflictIndex(
  entries: PluginEntryJson[],
  candidate: PluginEntryJson,
): number {
  return entries.findIndex((entry) =>
    candidate.path !== undefined
      ? entry.path === candidate.path
      : entry.name !== undefined && entry.name === candidate.name,
  );
}

/**
 * Copy of `entry` with the enabled state applied. Enabled is the default,
 * so enabling removes the key rather than writing `enabled: true`.
 */
export function withEnabled(
  entry: PluginEntryJson,
  enabled: boolean,
): PluginEntryJson {
  const { enabled: _drop, ...rest } = entry;
  return enabled ? rest : { ...rest, enabled: false };
}

/**
 * Package name of an npm spec, version stripped: `pkg@1.2` → `pkg`,
 * `@scope/pkg@^1` → `@scope/pkg`. A leading `@` is the scope, not a version.
 */
export function npmSpecName(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}
