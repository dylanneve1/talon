/**
 * Types describing the JSON script that drives `fake-codex.mjs`.
 *
 * The Codex backend talks to the `codex` CLI through the `@openai/codex-sdk`,
 * which spawns `codex exec --experimental-json ...` ONCE PER TURN, writes the
 * prompt to stdin, and reads newline-delimited `ThreadEvent` JSON from stdout
 * until the process exits 0. (Contrast with the Claude stub: one long-lived
 * process that receives every user message over stdin.)
 *
 * Because the binary is re-spawned per turn, the stub tracks "which turn am I"
 * via a counter file (`STUB_CODEX_STATE`) that persists across invocations.
 * Turn N of the script fires on the Nth spawn.
 *
 * For the SDK's event shapes, see:
 *   node_modules/@openai/codex-sdk/dist/index.d.ts  (ThreadEvent, ThreadItem)
 */

export interface CodexStubScript {
  /** Override the auto-generated thread id emitted in `thread.started`. */
  threadId?: string;
  /** Sequential turns. Turn N fires on the Nth spawn of the binary. */
  turns?: CodexStubTurn[];
  /**
   * When true, every emitted `mcp_tool_call` is actually dispatched through a
   * real MCP client connection to the configured server (reconstructed from
   * the `--config mcp_servers.*` argv the codex-sdk passes), so the tool call
   * routes through Talon's gateway exactly as in production. The MCP result is
   * folded into the emitted `item.completed`. Default: `false`.
   */
  dispatchMcp?: boolean;
}

export interface CodexStubTurn {
  /** Items to emit (in order) between `turn.started` and `turn.completed`. */
  emit?: CodexEmit[];
  /** Usage reported on `turn.completed`. */
  usage?: CodexUsage;
  /** Emit a `turn.failed` with this error message instead of `turn.completed`. */
  fail?: string;
}

export interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}

export type CodexEmit =
  CodexAgentMessage | CodexMcpToolCall | CodexReasoning | CodexRawItem;

/** The model's final reply text (Codex coalesces deltas into one block). */
export interface CodexAgentMessage {
  type: "agent_message";
  text: string;
}

/**
 * An MCP tool call. When `dispatchMcp` is on, the stub connects to the named
 * server and actually invokes `tool` with `arguments`, routing through Talon's
 * gateway. The real MCP result is merged into the emitted `item.completed`.
 */
export interface CodexMcpToolCall {
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** Override the item id (defaults to a random one). */
  id?: string;
}

/** Private reasoning — the handler ignores it, but tests may want to emit it. */
export interface CodexReasoning {
  type: "reasoning";
  text: string;
}

/** Escape hatch: emit an arbitrary `ThreadItem` verbatim as `item.completed`. */
export interface CodexRawItem {
  type: string;
  [key: string]: unknown;
}
