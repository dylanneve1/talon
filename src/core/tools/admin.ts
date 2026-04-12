/**
 * Admin tools — plugin management and system operations.
 *
 * These tools operate on the Talon runtime itself rather than
 * messaging or content. Available on all frontends.
 */

import type { ToolDefinition } from "./types.js";

export const adminTools: ToolDefinition[] = [
  {
    name: "reload_plugins",
    description: `Hot-reload all MCP plugins without restarting the bot. Re-reads ~/.talon/config.json, destroys current plugin instances, loads fresh ones, and resets sessions so new MCP servers spawn on the next message.

Use this after editing the plugin config (adding, removing, or updating plugin entries) to apply changes without downtime.

Returns the list of successfully loaded plugins and number of sessions reset.`,
    schema: {},
    execute: (_params, bridge) => bridge("reload_plugins", {}),
    tag: "admin",
  },
];
