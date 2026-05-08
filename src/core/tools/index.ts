/**
 * Tool registry — compose filtered tool sets at runtime.
 *
 * Import domain modules, expose a single composeTools() API
 * that backends and the MCP server use to get the right tool set.
 */

import type { ToolDefinition, ToolFrontend, ToolTag } from "./types.js";

import { messagingTools } from "./messaging.js";
import { chatTools } from "./chat.js";
import { historyTools } from "./history.js";
import { memberTools } from "./members.js";
import { mediaTools } from "./media.js";
import { stickerTools } from "./stickers.js";
import { schedulingTools } from "./scheduling.js";
import { webTools } from "./web.js";
import { adminTools } from "./admin.js";

/** All built-in tool definitions. */
export const ALL_TOOLS: readonly ToolDefinition[] = [
  ...messagingTools,
  ...chatTools,
  ...historyTools,
  ...memberTools,
  ...mediaTools,
  ...stickerTools,
  ...schedulingTools,
  ...webTools,
  ...adminTools,
];

/**
 * Names of tools that explicitly terminate the model's turn.
 *
 * Backend handlers consume this set to abort their stream loop after
 * observing one of these tools — without it, the model can keep producing
 * trailing scratchpad prose after declaring "I'm done", which trips the
 * flow-violation re-prompt path. Declaration is on the tool definition
 * (`endsTurn: true`); detection is shared; abort is backend-specific.
 */
const TURN_TERMINATOR_NAMES: ReadonlySet<string> = new Set(
  ALL_TOOLS.filter((t) => t.endsTurn).map((t) => t.name),
);

/**
 * Strip an MCP server prefix (`mcp__<server>__`) from a tool name.
 *
 * Tools served through MCP arrive at the SDK with the prefix attached
 * (e.g. `mcp__telegram-tools__end_turn`), while the registry stores them
 * by their bare name (`end_turn`). Callers that want to compare against
 * the registry should normalize first.
 *
 * Returns the input unchanged if no prefix matches — safe to call on any
 * tool name. The non-greedy `.+?` matches the FIRST `__` boundary after
 * `mcp__`, which is the server-name terminator in MCP's naming scheme.
 */
export function stripMcpPrefix(toolName: string): string {
  return toolName.replace(/^mcp__.+?__/, "");
}

/**
 * Whether a tool call by this name should terminate the model's turn.
 *
 * Accepts both bare names (`end_turn`) and MCP-prefixed names
 * (`mcp__telegram-tools__end_turn`) — the prefix is stripped before
 * comparing against the terminator set.
 */
export function isTurnTerminator(toolName: string): boolean {
  if (TURN_TERMINATOR_NAMES.has(toolName)) return true;
  return TURN_TERMINATOR_NAMES.has(stripMcpPrefix(toolName));
}

/** Filter options for composing a tool set. */
export interface ComposeOptions {
  /** Include only tools available on this frontend. */
  frontend?: ToolFrontend;
  /** Include only tools with these tags. */
  tags?: ToolTag[];
  /** Exclude tools with these tags. */
  excludeTags?: ToolTag[];
  /** Exclude specific tools by name. */
  excludeNames?: string[];
}

/**
 * Compose a filtered set of tools at runtime.
 *
 * When no options are provided, returns ALL_TOOLS unchanged.
 * Callers describe what they need and get back matching definitions.
 */
export function composeTools(options: ComposeOptions = {}): ToolDefinition[] {
  let tools = [...ALL_TOOLS];

  if (options.frontend) {
    tools = tools.filter(
      (t) =>
        !t.frontends ||
        t.frontends.includes("all") ||
        t.frontends.includes(options.frontend!),
    );
  }

  if (options.tags?.length) {
    tools = tools.filter((t) => options.tags!.includes(t.tag));
  }

  if (options.excludeTags?.length) {
    tools = tools.filter((t) => !options.excludeTags!.includes(t.tag));
  }

  if (options.excludeNames?.length) {
    tools = tools.filter((t) => !options.excludeNames!.includes(t.name));
  }

  return tools;
}

// Re-export types for convenience
export type {
  ToolDefinition,
  ToolFrontend,
  ToolTag,
  BridgeFunction,
} from "./types.js";
