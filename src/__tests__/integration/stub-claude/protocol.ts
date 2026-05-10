/**
 * Types describing the JSON script that drives `fake-claude.mjs`.
 *
 * A script is a list of "turns." Each turn is consumed in order — the Nth user
 * message the SDK sends to the binary triggers the Nth turn's `emit` array.
 * Within a turn, each emitted message is written to stdout as a single JSONL
 * line. The stub binary fills in safe defaults (session_id, message id, usage,
 * stop_reason) so test scripts only need to specify what's relevant.
 *
 * For the SDK's content-block shapes, see the upstream type definitions:
 *   node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
 */

export interface StubScript {
  /** Override the auto-generated session id. */
  sessionId?: string;
  /** Override the default `SDKControlInitializeResponse` payload. */
  initResponse?: Record<string, unknown>;
  /** Override the default `system/init` event. */
  systemInit?: Record<string, unknown>;
  /** Sequential turns. Turn N is consumed on the Nth user message received. */
  turns?: StubTurn[];
  /**
   * When true, the stub auto-dispatches every emitted `tool_use` block whose
   * name matches the `mcp__<server>__<tool>` shape via a real MCP client
   * connection to the configured server. The result is recorded in the
   * protocol log and (optionally) inserted into the SDK stream as a
   * synthetic `tool_result` so downstream assistant turns can chain on it.
   *
   * The MCP server config comes from `--mcp-config` on the stub's argv —
   * the SDK passes that automatically based on the `mcpServers` option,
   * which Talon's `buildMcpServers` populates when the bootstrap config
   * uses a non-terminal frontend (e.g. `frontend: "telegram"`).
   *
   * Default: `false`. Existing tests don't need to opt in.
   */
  dispatchMcp?: boolean;
}

export interface StubTurn {
  /** Messages to write to stdout when this turn fires, in order. */
  emit?: StubEmit[];
}

export type StubEmit = StubAssistant | StubResult | StubFireHook | StubRaw;

/**
 * Pseudo-emit handled by `fake-claude.mjs` — synthesizes a `hook_callback`
 * control_request to the SDK, mimicking what the real CLI does when it
 * dispatches a tool batch and reaches a hook event. If the hook returns
 * `continue: false`, the stub halts subsequent emits in this turn.
 */
export interface StubFireHook {
  type: "_fire_hook";
  event:
    | "PreToolUse"
    | "PostToolUse"
    | "PostToolBatch"
    | "Stop"
    | "SessionStart"
    | "SessionEnd";
  input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface StubAssistant {
  type: "assistant";
  message?: {
    model?: string;
    content?: ContentBlock[];
    stop_reason?: string;
    stop_sequence?: string | null;
    usage?: { input_tokens: number; output_tokens: number };
  };
  parent_tool_use_id?: string | null;
}

export interface StubResult {
  type: "result";
  subtype?:
    | "success"
    | "error_during_execution"
    | "error_max_turns"
    | "error_during_streaming";
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number };
}

/**
 * Escape hatch for raw protocol messages (e.g. `system`, `stream_event`,
 * arbitrary control responses) that don't fit the high-level helpers.
 */
export interface StubRaw {
  type: string;
  [key: string]: unknown;
}

// ── Content blocks (subset, mirrors @anthropic-ai/sdk Anthropic.Messages) ───

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
