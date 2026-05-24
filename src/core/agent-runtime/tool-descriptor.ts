/**
 * Canonical tool descriptor.
 *
 * One source of truth for "what tools exist, what are they for, who
 * can call them, what's the schema". Backends render this into their
 * SDK-native format (Claude SDK MCP config, Codex TOML MCP config,
 * OpenAI Agents `MCPServerStdio`) but they all start from the same
 * `ToolDescriptor[]` derived from the active `RunPolicy`.
 *
 * Phase 1 only adds the type. The current backends still build their
 * MCP configs from `src/plugins/*` and the per-frontend tool lists in
 * `src/util/mcp-launcher.mjs`. Phase 5 introduces a `ToolRegistry`
 * that turns those into `ToolDescriptor[]`s.
 */

/**
 * Descriptor for one tool surfaced to the model.
 *
 * `id` is the routing key the backend uses. For MCP-namespaced tools
 * (the common case in Talon today) it's `mcp__<server>__<name>`. For
 * builtin SDK tools it's just `name`. `server` is the human-readable
 * MCP server label when applicable.
 */
export interface ToolDescriptor {
  /** Routing key. Globally unique per Talon process. */
  id: string;
  /** MCP server label, when this tool comes from one. */
  server?: string;
  /** Unprefixed tool name (matches MCP schema `name` field). */
  name: string;
  /** Short human-readable description for tool-search and logs. */
  description?: string;
  /** JSON-schema input shape; opaque to core. Backends pass through. */
  inputSchema?: unknown;
  /**
   * Free-form tags for grouping in pickers, telemetry, and policy
   * decisions. Conventional values: `"messaging"`, `"delivery"`,
   * `"memory"`, `"web"`, `"shell"`, `"network"`, `"readonly"`.
   * Lowercase, no separators.
   */
  tags: string[];
  /**
   * Whether calling this tool delivers a final reply to the user
   * (`end_turn`, `send`, `react`). The dispatcher uses this to
   * detect run terminators without a hardcoded name list.
   */
  delivery?: boolean;
  /**
   * Whether this tool requires an ambient chat context (i.e. it
   * implicitly knows which chat to act on). Heartbeats refuse these
   * unless an explicit `chat_id` is also accepted.
   */
  requiresAmbientChat?: boolean;
  /**
   * Whether this tool only reads state. Read-only tools are
   * candidates for inclusion in dream / test policies that
   * otherwise restrict outbound action.
   */
  readOnly?: boolean;
}

/**
 * Filter predicates used by `RunPolicy.tools` to derive the allowed
 * tool set from the master registry. Each filter is "tool is
 * allowed if ALL declared predicates pass". An empty filter passes
 * everything through.
 */
export interface ToolFilter {
  /** Allowlist by `id`. Empty/undefined = no id restriction. */
  ids?: string[];
  /** Allowlist by `server`. Empty/undefined = no server restriction. */
  servers?: string[];
  /** Required tags. A tool passes if every required tag is present. */
  requiredTags?: string[];
  /** Disallowed tags. A tool fails if any disallowed tag is present. */
  forbiddenTags?: string[];
  /** Restrict to read-only tools. */
  readOnlyOnly?: boolean;
  /** Restrict to / exclude delivery tools. */
  excludeDelivery?: boolean;
  /** Restrict to / exclude tools requiring ambient chat. */
  excludeAmbientChatTools?: boolean;
}

/**
 * Apply a `ToolFilter` to a list of descriptors. Pure — used by
 * `RunPolicy` consumers and Phase 5 backend tool renderers.
 */
export function applyToolFilter(
  tools: readonly ToolDescriptor[],
  filter: ToolFilter | undefined,
): ToolDescriptor[] {
  if (!filter) return [...tools];
  return tools.filter((tool) => toolMatches(tool, filter));
}

function toolMatches(tool: ToolDescriptor, filter: ToolFilter): boolean {
  if (filter.ids && filter.ids.length > 0 && !filter.ids.includes(tool.id)) {
    return false;
  }
  if (
    filter.servers &&
    filter.servers.length > 0 &&
    (!tool.server || !filter.servers.includes(tool.server))
  ) {
    return false;
  }
  if (filter.requiredTags && filter.requiredTags.length > 0) {
    for (const required of filter.requiredTags) {
      if (!tool.tags.includes(required)) return false;
    }
  }
  if (filter.forbiddenTags && filter.forbiddenTags.length > 0) {
    for (const forbidden of filter.forbiddenTags) {
      if (tool.tags.includes(forbidden)) return false;
    }
  }
  if (filter.readOnlyOnly && !tool.readOnly) return false;
  if (filter.excludeDelivery && tool.delivery) return false;
  if (filter.excludeAmbientChatTools && tool.requiresAmbientChat) return false;
  return true;
}
