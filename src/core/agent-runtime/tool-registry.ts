/**
 * `ToolRegistry` — canonical store of `ToolDescriptor`s for one
 * Talon process.
 *
 * Phase 5 of the architecture unification plan introduces a single
 * source of truth for "what tools exist, who can call them, what's
 * the schema". Backends render the registry into their SDK-native
 * format (Claude SDK MCP config, Codex TOML MCP config, OpenAI
 * Agents `MCPServerStdio`) but they all start from the same
 * `ToolDescriptor[]` derived from the active `RunPolicy`.
 *
 * This module ships the **storage + filter** layer. Per the plan's
 * "First target: Codex TOML MCP config + Claude SDK MCP config" —
 * the backend-side renderers belong in their respective backend
 * modules and land in Phase 5.x PRs.
 *
 * Phase 1-2 contract: **no production caller invokes the registry
 * yet.** The current backends still build their MCP configs from
 * `src/plugins/*` and `src/util/mcp-launcher.mjs`. Phase 5.x
 * migrates them.
 *
 * Design notes
 * ────────────
 *
 *   - The registry is process-scoped. Tests can create a fresh
 *     instance via `new ToolRegistry()`.
 *
 *   - `register()` rejects duplicate ids — failing loudly at
 *     registration is the right shape because tool id collisions
 *     are silent footguns in production (one backend ignores the
 *     loser's schema, model calls fail mysteriously).
 *
 *   - `forPolicy(policy)` returns the filtered subset for a given
 *     `RunPolicy`. The same registry can serve chat / heartbeat /
 *     dream — the policy decides what's exposed.
 */

import { applyToolFilter, type ToolDescriptor } from "./tool-descriptor.js";
import type { RunPolicy } from "./run-policy.js";

/**
 * Errors thrown by registry mutations. Use `instanceof
 * ToolRegistryError` to distinguish from generic errors.
 */
export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRegistryError";
  }
}

/**
 * Canonical store of `ToolDescriptor`s. Backends ask for a filtered
 * view via `forPolicy(policy)` rather than enumerating themselves.
 */
export class ToolRegistry {
  #tools = new Map<string, ToolDescriptor>();

  /**
   * Register a tool. Throws `ToolRegistryError` if the id is
   * already taken — collisions are surfaced at registration time
   * so they can't masquerade as missing tools at call time.
   */
  register(descriptor: ToolDescriptor): void {
    if (this.#tools.has(descriptor.id)) {
      throw new ToolRegistryError(
        `Tool "${descriptor.id}" already registered — duplicate id`,
      );
    }
    this.#tools.set(descriptor.id, cloneDescriptor(descriptor));
  }

  /**
   * Register many tools atomically. If ANY id is a duplicate, the
   * whole batch is rolled back and the error is thrown.
   */
  registerAll(descriptors: readonly ToolDescriptor[]): void {
    const seen = new Set<string>();
    for (const d of descriptors) {
      if (this.#tools.has(d.id) || seen.has(d.id)) {
        throw new ToolRegistryError(
          `Tool "${d.id}" already registered — duplicate id (atomic batch)`,
        );
      }
      seen.add(d.id);
    }
    for (const d of descriptors) {
      this.#tools.set(d.id, cloneDescriptor(d));
    }
  }

  /**
   * Look up a single descriptor by id. Returns `undefined` if
   * unknown.
   */
  get(id: string): ToolDescriptor | undefined {
    const entry = this.#tools.get(id);
    return entry ? cloneDescriptor(entry) : undefined;
  }

  /**
   * Whether a tool with this id is registered.
   */
  has(id: string): boolean {
    return this.#tools.has(id);
  }

  /**
   * Number of tools currently registered.
   */
  size(): number {
    return this.#tools.size;
  }

  /**
   * Snapshot of every registered descriptor. Sorted by id for
   * deterministic output. Returns a fresh array — caller can
   * mutate without affecting the registry.
   */
  list(): ToolDescriptor[] {
    return [...this.#tools.values()]
      .map(cloneDescriptor)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Subset of the registry matching the given `RunPolicy.tools`
   * filter. Wraps `applyToolFilter` so backends don't have to
   * inline the filter logic.
   *
   * The returned list is freshly allocated and sorted by id.
   */
  forPolicy(policy: RunPolicy): ToolDescriptor[] {
    const all = this.list();
    return applyToolFilter(all, policy.tools.filter);
  }

  /**
   * Remove a tool by id. Returns `true` if it was present.
   */
  unregister(id: string): boolean {
    return this.#tools.delete(id);
  }

  /**
   * Empty the registry — test-only utility.
   */
  clear(): void {
    this.#tools.clear();
  }
}

/**
 * Deep-ish clone — copy the descriptor's fields and clone the `tags`
 * array so caller mutations on the returned object can't leak into
 * the registry's stored state. `inputSchema` is treated as opaque
 * (`unknown`); callers can use `JSON.parse(JSON.stringify(...))` if
 * they need a fully detached snapshot of it.
 */
function cloneDescriptor(t: ToolDescriptor): ToolDescriptor {
  return {
    ...t,
    tags: [...t.tags],
  };
}

/**
 * Convenience: detect MCP tools by id prefix (`mcp__<server>__`).
 * Useful when callers want to group tools by server for rendering
 * Codex TOML or Claude MCP config blocks.
 */
export function parseMcpToolId(
  id: string,
): { server: string; name: string } | null {
  const match = id.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!match) return null;
  // Server names CAN contain hyphens but NOT double-underscores
  // (the latter is the canonical separator). Take everything
  // between the first and last "__" pair.
  const idx = id.indexOf("__", 5); // skip the leading "mcp__"
  if (idx === -1) return null;
  return {
    server: id.slice(5, idx),
    name: id.slice(idx + 2),
  };
}

/**
 * Group tools by their `server` field (or "builtin" for tools with
 * no server). Returns a `Map<server, ToolDescriptor[]>` sorted by
 * server name; each group's contents are sorted by name.
 *
 * Useful for backend renderers that emit per-server MCP config
 * blocks.
 */
export function groupToolsByServer(
  tools: readonly ToolDescriptor[],
): Map<string, ToolDescriptor[]> {
  const groups = new Map<string, ToolDescriptor[]>();
  for (const tool of tools) {
    const key = tool.server ?? "builtin";
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(cloneDescriptor(tool));
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.name.localeCompare(b.name));
  }
  // Map iteration follows insertion order — re-emit sorted by key
  // so the output is deterministic regardless of registration order.
  const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const out = new Map<string, ToolDescriptor[]>();
  for (const k of sortedKeys) {
    out.set(k, groups.get(k)!);
  }
  return out;
}
