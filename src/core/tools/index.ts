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
];

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
export type { ToolDefinition, ToolFrontend, ToolTag, BridgeFunction } from "./types.js";
