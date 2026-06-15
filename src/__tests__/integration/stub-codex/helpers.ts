/**
 * Script builders for the fake codex binary. Mirror the stub-claude helpers so
 * tests read the same way across backends.
 */
import type {
  CodexAgentMessage,
  CodexMcpToolCall,
  CodexStubTurn,
} from "./protocol.js";

/** The model's final reply text. */
export function agentMessage(text: string): CodexAgentMessage {
  return { type: "agent_message", text };
}

/** An MCP tool call (e.g. the `end_turn` delivery tool on `telegram-tools`). */
export function mcpToolCall(
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
): CodexMcpToolCall {
  return { type: "mcp_tool_call", server, tool, arguments: args };
}

/**
 * Convenience: a turn that delivers `text` via the canonical `end_turn` tool on
 * the telegram-tools MCP server — the production delivery path for codex.
 */
export function endTurnTurn(text: string): CodexStubTurn {
  return { emit: [mcpToolCall("telegram-tools", "end_turn", { text })] };
}

/** A turn that just emits trailing `agent_message` prose (no delivery tool). */
export function proseTurn(text: string): CodexStubTurn {
  return { emit: [agentMessage(text)] };
}
