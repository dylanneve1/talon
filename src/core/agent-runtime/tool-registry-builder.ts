/**
 * `buildToolRegistryFromCatalog` — populate a `ToolRegistry` from
 * the existing `ALL_TOOLS` catalog in `core/tools/index.ts`.
 *
 * Phase 5 of the architecture unification plan asks every backend
 * to derive its tool surface from a single registry rather than
 * reimplementing the catalog walk per backend. This builder is the
 * conversion layer: each `ToolDefinition` becomes a `ToolDescriptor`
 * with the tag carried over, `delivery: endsTurn`, and
 * `requiresAmbientChat` inferred from the legacy frontend allowlist
 * (frontend-scoped tools that aren't `terminal` need ambient chat
 * context — terminal is the only one that runs without one).
 *
 * The builder is stateless; callers construct one registry per
 * Talon process (or per test). The result is a live `ToolRegistry`
 * that supports `forPolicy(policy)` filtering against the policy's
 * `tools.filter` predicates.
 */

import { ALL_TOOLS } from "../tools/index.js";
import type { ToolDefinition, ToolTag } from "../tools/types.js";
import { ToolRegistry } from "./tool-registry.js";
import type { ToolDescriptor } from "./tool-descriptor.js";

/**
 * Convert one legacy `ToolDefinition` into the canonical
 * `ToolDescriptor` shape. The mapping is purely declarative:
 *
 *   - `id`            = `name` (Talon's builtin tools are not
 *                       MCP-namespaced; per-plugin MCP tools get
 *                       added separately via `registerPluginTools`).
 *   - `name`          = `name`
 *   - `description`   = `description`
 *   - `tags`          = [tag]
 *   - `delivery`      = `endsTurn ?? false`
 *   - `requiresAmbientChat` = tool is frontend-scoped to anything
 *                             other than `terminal`. (Terminal runs
 *                             without an ambient chat; the others
 *                             always do.)
 *   - `readOnly`      = inferred from tag (`history`, `members`,
 *                       `media`, `web` are read-only; the rest mutate
 *                       state).
 *
 * The `inputSchema` field is set to `undefined` because legacy
 * `ToolDefinition.schema` is a Zod raw shape, not a JSON schema;
 * backends that need a wire-format schema render it themselves.
 */
export function toolDefinitionToDescriptor(
  tool: ToolDefinition,
): ToolDescriptor {
  return {
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: [tool.tag],
    delivery: tool.endsTurn ?? false,
    // Frontend-scoped to anything other than "terminal" means the
    // tool needs an ambient chat context. Terminal CLI sessions
    // run without one; the bot frontends always have one.
    requiresAmbientChat: tool.frontends
      ? !tool.frontends.includes("terminal")
      : true,
    readOnly: isReadOnlyTag(tool.tag),
  };
}

const READ_ONLY_TAGS: ReadonlySet<ToolTag> = new Set([
  "history",
  "members",
  "media",
  "web",
]);

function isReadOnlyTag(tag: ToolTag): boolean {
  return READ_ONLY_TAGS.has(tag);
}

/**
 * Build a fresh `ToolRegistry` from the catalog. Idempotent — each
 * call returns a new registry instance populated with the same
 * descriptors.
 */
export function buildToolRegistryFromCatalog(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll(ALL_TOOLS.map(toolDefinitionToDescriptor));
  return registry;
}

/**
 * Process-scoped lazy singleton. Bootstrap calls this once to
 * populate the registry from `ALL_TOOLS`; downstream consumers
 * (backends rendering MCP config, dispatcher checking policy)
 * read through the same instance.
 *
 * Tests that need isolation should call `resetGlobalToolRegistry()`
 * before constructing their own.
 */
let cached: ToolRegistry | null = null;

export function getGlobalToolRegistry(): ToolRegistry {
  if (!cached) {
    cached = buildToolRegistryFromCatalog();
  }
  return cached;
}

export function resetGlobalToolRegistry(): void {
  cached = null;
}
