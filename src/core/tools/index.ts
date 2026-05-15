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
import { triggerTools } from "./triggers.js";
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
  ...triggerTools,
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
 * All tool names registered in Talon's tool catalog. Used by
 * `stripMcpPrefix` to recognise the bare name when a backend prefixes
 * the tool with its MCP server identifier in a non-standard way (e.g.
 * Kilo's `<server>_<bare>` instead of MCP's canonical `mcp__<server>__<bare>`).
 */
const ALL_TOOL_NAMES: ReadonlySet<string> = new Set(
  ALL_TOOLS.map((t) => t.name),
);

/**
 * Strip a backend's MCP server prefix from a tool name.
 *
 * Two prefix conventions are in the wild:
 *
 *   1. **Claude SDK / MCP canonical:** `mcp__<server>__<tool>`
 *      e.g. `mcp__telegram-tools__end_turn` → `end_turn`.
 *
 *   2. **Kilo / OpenCode:** `<server>_<tool>` (single underscore boundary,
 *      no `mcp__` prefix). e.g. `talon-tools-352042062_send` → `send`,
 *      `talon-tools-heartbeat_end_turn` → `end_turn`. Bare names that
 *      contain underscores (`end_turn`) make a "split on _" approach
 *      ambiguous, so we resolve by checking whether the trailing segment
 *      matches a known tool name and walking backward through underscore
 *      boundaries until we hit one.
 *
 * Returns the input unchanged when no recognised prefix matches — safe
 * to call on any tool name. Without the Kilo branch, deliveries via
 * `talon-tools-<chat>_send` were not deduped against the model's
 * trailing prose, so every tool-delivered reply was emitted twice
 * (once by the tool's bridge call, once by the handler's text-part
 * fallback).
 */
export function stripMcpPrefix(toolName: string): string {
  const mcpStripped = toolName.replace(/^mcp__.+?__/, "");
  if (mcpStripped !== toolName) return mcpStripped;

  // Kilo / OpenCode `<server>_<bare>` form. Walk underscore boundaries
  // from the right; the longest tail that matches a registered tool name
  // is the bare name. Prevents `talon-tools-352042062_end_turn` from
  // resolving to `turn` (which isn't a tool).
  const segments = toolName.split("_");
  for (let i = 1; i < segments.length; i++) {
    const tail = segments.slice(i).join("_");
    if (ALL_TOOL_NAMES.has(tail)) {
      return tail;
    }
  }
  return toolName;
}

/**
 * Whether a tool call by this name should terminate the model's turn.
 *
 * Accepts both bare names (`end_turn`) and MCP-prefixed names
 * (`mcp__telegram-tools__end_turn`) — the prefix is stripped before
 * comparing against the terminator set.
 *
 * Soft-terminator override: some terminators (notably `react`) accept a
 * per-call `end_turn: false` opt-out so the model can react and keep the
 * turn alive (e.g. react-with-🤔 then look something up). When the second
 * argument is provided and the call is one of the soft-terminator tools
 * with `end_turn: false`, this returns `false` so the SDK loop keeps
 * going. When omitted (or `end_turn !== false`), behaviour matches the
 * name-only check — strict terminator.
 */
export function isTurnTerminator(
  toolName: string,
  toolInput?: unknown,
): boolean {
  const matchedBare = TURN_TERMINATOR_NAMES.has(toolName);
  const matchedStripped =
    !matchedBare && TURN_TERMINATOR_NAMES.has(stripMcpPrefix(toolName));
  if (!matchedBare && !matchedStripped) return false;

  // Per-tool soft override: `react` honours an explicit `end_turn: false`.
  const baseName = matchedBare ? toolName : stripMcpPrefix(toolName);
  if (baseName === "react" && toolInput && typeof toolInput === "object") {
    const flag = (toolInput as { end_turn?: unknown }).end_turn;
    if (flag === false) return false;
  }
  return true;
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
