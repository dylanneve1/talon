/**
 * Script builders for the fake codex binary. Mirror the stub-claude helpers so
 * tests read the same way across backends.
 */
import type { CodexMcpToolCall } from "./protocol.js";

/** An MCP tool call (e.g. the `end_turn` delivery tool on `telegram-tools`). */
export function mcpToolCall(
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
): CodexMcpToolCall {
  return { type: "mcp_tool_call", server, tool, arguments: args };
}
