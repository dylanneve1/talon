/**
 * Codex event handling — translate `ThreadEvent` / `ThreadItem` values from
 * `runStreamed` into shared stream-state mutations and tool metrics.
 */

import type {
  ThreadEvent,
  ThreadItem,
  AgentMessageItem,
  FileChangeItem,
  McpToolCallItem,
} from "@openai/codex-sdk";
import { log, logWarn } from "../../../util/log.js";
import { isTurnTerminator, stripMcpPrefix } from "../../../core/tools/index.js";
import {
  recordToolUse,
  recordToolCall,
  type StreamState,
} from "../../shared/index.js";

export interface HandleEventContext {
  state: StreamState;
  seenToolCallIds: Set<string>;
  codexToolMetrics: { count: number };
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (
    toolName: string,
    input: Record<string, unknown>,
    meta?: { failed?: boolean },
  ) => void;
  chatId: string;
}

/**
 * Translate one Codex `ThreadEvent` into stream-state mutations.
 *
 * Synchronous — keeps the for-await loop simple. The shared
 * `routeDelivery` step at end-of-turn handles the final emit.
 */
export function handleEvent(event: ThreadEvent, ctx: HandleEventContext): void {
  if (event.type !== "item.completed") return;
  handleItem(event.item, ctx);
}

function handleItem(item: ThreadItem, ctx: HandleEventContext): void {
  switch (item.type) {
    case "agent_message":
      handleAgentMessage(item, ctx);
      return;
    case "mcp_tool_call":
      handleMcpToolCall(item, ctx);
      return;
    // Native Codex tools are reported under the fleet-wide tool
    // vocabulary (Bash / Edit / Write / WebSearch) so the shared
    // `tool_calls.<name>` metric keys line up with the Claude SDK
    // backend instead of splitting the same activity across
    // `tool_calls.command_execution` vs `tool_calls.Bash`.
    case "command_execution":
      handleNativeCodexTool(ctx, "Bash", {
        command: item.command,
        status: item.status,
        ...(typeof item.exit_code === "number"
          ? { exit_code: item.exit_code }
          : {}),
      });
      return;
    case "file_change":
      handleNativeCodexTool(ctx, fileChangeToolName(item.changes), {
        status: item.status,
        changes: item.changes,
      });
      return;
    case "web_search":
      handleNativeCodexTool(ctx, "WebSearch", { query: item.query });
      return;
    case "reasoning":
    case "todo_list":
    case "error":
      // Reasoning is private scratchpad; todo_list is planning state.
      // Neither maps to Talon's reply or tool metrics. Error items get
      // logged below.
      if (item.type === "error") {
        logWarn("agent", `[${ctx.chatId}] Codex error item: ${item.message}`);
      }
      return;
    default: {
      const type =
        typeof (item as { type?: unknown }).type === "string"
          ? (item as { type: string }).type
          : "unknown";
      handleNativeCodexTool(ctx, type, nativeItemPayload(item));
      return;
    }
  }
}

function handleAgentMessage(
  item: AgentMessageItem,
  ctx: HandleEventContext,
): void {
  // agent_message is the model's final reply. Codex emits one per
  // turn with the complete text (no need to accumulate deltas — the
  // SDK has already coalesced them).
  if (typeof item.text === "string" && item.text.trim()) {
    ctx.state.allResponseText = item.text;
    ctx.state.lastTrailingText = item.text;
  }
}

function handleMcpToolCall(
  item: McpToolCallItem,
  ctx: HandleEventContext,
): void {
  // Only act on terminal statuses. Codex SDK emits each mcp_tool_call
  // item twice: once with `status: "in_progress"` when it dispatches
  // the tool to the MCP server, and again with `status: "completed"`
  // (or `"failed"`) after the server returns. The earlier code
  // accepted both — combined with the `seenToolCallIds` dedup, that
  // meant we acted on whichever shape arrived first (in_progress,
  // every time).
  //
  // For terminator tools (`end_turn` / `send` / `react`) this is a
  // race: marking `turnTerminated` on `in_progress` flips the abort
  // controller BEFORE the bridge call has had a chance to execute the
  // delivery. The abort kills the Codex subprocess (and with it the
  // MCP tool subprocess) mid-flight — if the bridge HTTP call hasn't
  // gone out yet, delivery never happens. Same shape as the Claude SDK
  // send/end_turn race that PR #122 fixed via PostToolBatch.
  if (item.status === "in_progress") return;
  if (ctx.seenToolCallIds.has(item.id)) return;
  ctx.seenToolCallIds.add(item.id);

  // Codex names MCP tools as `<server>.<tool>` in the call item; the
  // shared `recordToolUse` / `isTurnTerminator` expect the bare tool
  // name (or `mcp__<server>__<tool>` form). Normalise via the upstream
  // tool name on the item.
  const toolName = item.tool;
  const input =
    item.arguments && typeof item.arguments === "object"
      ? (item.arguments as Record<string, unknown>)
      : {};

  const bareToolName = stripMcpPrefix(toolName);
  recordCodexToolMetric(ctx, bareToolName);

  if (item.status === "failed") {
    // A failed call is still a call — the Claude SDK backend counts
    // every tool_use block regardless of outcome, so codex must too or
    // the fleet-wide `tool_calls.*` keys silently undercount. But
    // nothing was delivered and the turn is not terminated, so skip
    // the stream-state mutations (delivered-text capture / terminator
    // flip) that assume a successful call.
    if (ctx.onToolUse) {
      try {
        ctx.onToolUse(toolName, input, { failed: true });
      } catch {
        /* non-fatal */
      }
    }
    return;
  }

  recordToolUse(ctx.state, toolName, input);

  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch {
      /* non-fatal */
    }
  }

  if (!ctx.state.turnTerminated && isTurnTerminator(toolName, input)) {
    ctx.state.turnTerminated = true;
    log(
      "agent",
      `[Codex] terminator fired: ${describeToolCall(toolName, input)}`,
    );
  }
}

function recordCodexToolMetric(
  ctx: HandleEventContext,
  toolName: string,
): void {
  // Shared vocabulary: `tool_calls.<bare>` (prefix-stripped, so codex
  // MCP calls land on the same keys as every other backend) plus the
  // `backend.codex.tool_calls` dimension.
  recordToolCall(ctx.chatId, toolName, "codex");
  ctx.codexToolMetrics.count += 1;
}

function handleNativeCodexTool(
  ctx: HandleEventContext,
  toolName: string,
  input: Record<string, unknown>,
): void {
  recordCodexToolMetric(ctx, toolName);
  if (ctx.onToolUse) {
    try {
      ctx.onToolUse(toolName, input);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Map a Codex `file_change` patch to the fleet-wide tool vocabulary.
 * A patch that only creates files is a `Write`; anything touching an
 * existing file (update / delete, or a mixed patch) is an `Edit` —
 * mirroring the Claude SDK tool split so metrics line up.
 */
function fileChangeToolName(changes: FileChangeItem["changes"]): string {
  return changes.length > 0 && changes.every((c) => c.kind === "add")
    ? "Write"
    : "Edit";
}

function nativeItemPayload(item: unknown): Record<string, unknown> {
  if (!item || typeof item !== "object") {
    return {};
  }
  const { id: _id, type: _type, ...payload } = item as Record<string, unknown>;
  return payload;
}

/** One-line summary of a tool call for the operator log. */
function describeToolCall(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const parts: string[] = [toolName];
  if (typeof input.type === "string") parts.push(`type=${input.type}`);
  if (typeof input.text === "string") {
    parts.push(`text=${input.text.length}chars`);
  }
  if (typeof input.emoji === "string") parts.push(`emoji=${input.emoji}`);
  if (typeof input.end_turn === "boolean") {
    parts.push(`end_turn=${input.end_turn}`);
  }
  return parts.join(" ");
}
