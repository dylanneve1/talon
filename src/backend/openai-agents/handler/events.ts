/**
 * OpenAI Agents event handling — translate `RunItemStreamEvent` values into
 * shared stream-state mutations and tool metrics.
 */

import { log } from "../../../util/log.js";
import { isTurnTerminator } from "../../../core/tools/index.js";
import {
  createStreamState,
  recordToolUse,
  recordToolCall,
} from "../../shared/index.js";

export interface HandleRunItemContext {
  state: ReturnType<typeof createStreamState>;
  seenToolCallIds: Set<string>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
  chatId: string;
}

/**
 * Translate one `RunItemStreamEvent` into stream-state mutations.
 *
 * The Agents SDK emits these as the agent loop progresses:
 *   - `tool_called` — the model decided to call a tool. We record the
 *     tool use + check for turn terminators (`end_turn` / `send` / `react`).
 *   - `message_output_created` — the model produced a (possibly final)
 *     assistant message. We capture the text for the trailing-prose path.
 *   - Other event names — silently ignored.
 */
export function handleRunItem(
  event: { name: string; item: unknown },
  ctx: HandleRunItemContext,
): void {
  switch (event.name) {
    case "tool_called":
      handleToolCalled(event.item, ctx);
      return;
    case "message_output_created":
      handleMessageOutput(event.item, ctx);
      return;
    default:
      // Other events don't map to Talon's reply channel.
      return;
  }
}

/** Pull a tool call out of the item payload and feed it into stream state. */
function handleToolCalled(item: unknown, ctx: HandleRunItemContext): void {
  // RunItem shapes for tool calls vary by tool kind (function tool /
  // MCP tool / hosted tool); the common surface is `rawItem` with the
  // tool name + arguments + id. Defensive narrowing.
  if (!item || typeof item !== "object") return;
  const raw = (item as { rawItem?: Record<string, unknown> }).rawItem;
  if (!raw || typeof raw !== "object") return;
  // Log a compact view of every tool call so we can correlate
  // tools=N / terminator / delivered numbers with the model's actual
  // intent in production. Truncated to keep the log light.
  try {
    const rawName = typeof raw.name === "string" ? raw.name : "?";
    const rawArgs =
      typeof raw.arguments === "string"
        ? raw.arguments.slice(0, 200)
        : JSON.stringify(raw.arguments ?? {}).slice(0, 200);
    log("agent", `[${ctx.chatId}] tool_call ${rawName} args=${rawArgs}`);
  } catch {
    /* skip */
  }

  // MCP tool calls expose `name` (the bare tool name) and `arguments`
  // (the JSON-decoded input). Function tool calls use the same fields.
  const toolName =
    typeof raw.name === "string"
      ? raw.name
      : typeof (raw as { tool?: string }).tool === "string"
        ? (raw as { tool: string }).tool
        : "tool";
  const callId =
    typeof raw.callId === "string"
      ? raw.callId
      : typeof raw.id === "string"
        ? raw.id
        : undefined;

  // Dedup against repeated emissions for the same call id.
  if (callId && ctx.seenToolCallIds.has(callId)) return;
  if (callId) ctx.seenToolCallIds.add(callId);

  // `arguments` arrives as either an already-parsed object or a JSON
  // string (depending on the tool kind). Normalise to a record.
  let input: Record<string, unknown> = {};
  const argsField = raw.arguments;
  if (argsField && typeof argsField === "object") {
    input = argsField as Record<string, unknown>;
  } else if (typeof argsField === "string") {
    try {
      const parsed = JSON.parse(argsField);
      if (parsed && typeof parsed === "object") {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      /* leave input empty — best-effort */
    }
  }

  recordToolCall(ctx.chatId, toolName, "openai-agents");
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
      `[OpenAI Agents] terminator fired: ${describeToolCall(toolName, input)}`,
    );
  }
}

/** Pull the assistant message text out of a `message_output_created` event. */
function handleMessageOutput(item: unknown, ctx: HandleRunItemContext): void {
  if (!item || typeof item !== "object") return;
  const raw = (item as { rawItem?: Record<string, unknown> }).rawItem;
  if (!raw || typeof raw !== "object") return;

  // The Responses API message shape is `{ role: "assistant", content: [{type: "output_text", text: "..."}, ...] }`.
  // Walk the content array and pick up text segments.
  const content = (raw as { content?: unknown[] }).content;
  if (!Array.isArray(content)) return;

  let combined = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: unknown };
    if (
      (p.type === "output_text" || p.type === "text") &&
      typeof p.text === "string"
    ) {
      combined += p.text;
    }
  }

  if (combined.trim()) {
    ctx.state.allResponseText = combined;
    ctx.state.lastTrailingText = combined;
  }
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
