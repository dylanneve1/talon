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
    description: `Hot-reload all MCP plugins without restarting the bot or disrupting active sessions. Re-reads ~/.talon/config.json, tears down current plugin instances, cleans up their env vars, and loads fresh ones.

Use this after editing the plugin config (adding, removing, or updating plugin entries) to apply changes without downtime. Active conversations continue uninterrupted — new plugin tools become available on the next tool call.

Returns the list of successfully loaded plugins.`,
    schema: {},
    execute: (_params, bridge) => bridge("reload_plugins", {}),
    tag: "admin",
  },
];
