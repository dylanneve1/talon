/**
 * Antigravity stream-json event model.
 *
 * The CLI emits newline-delimited JSON on stdout: exactly one `init`,
 * any number of `step_update`s, and exactly one `result` per turn.
 * Diagnostics never appear here — they go to stderr. This module owns
 * the wire types, the line parser, and the translation of one
 * `step_update` into shared stream-state mutations.
 *
 * The single agy-specific wrinkle is MCP: every MCP tool reaches the
 * model through one generic native tool, `call_mcp_tool`, whose
 * parameters are `{ServerName, ToolName, Arguments}`. Reporting that
 * name verbatim would hide `end_turn` / `send` from the terminator
 * logic and split the fleet-wide `tool_calls.*` metric keys, so
 * [describeAgyTool] unwraps it and every consumer downstream sees the
 * bare tool name like any other backend.
 */

import { log, logWarn } from "../../util/log.js";
import { isTurnTerminator } from "../../core/tools/index.js";
import {
  appendText,
  recordToolUse,
  recordToolCall,
  type StreamState,
} from "../runtime/index.js";

// ── Wire types ──────────────────────────────────────────────────────────────

/** Token counters agy reports per step and per result. */
export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  /**
   * Reasoning tokens. A SUBSET of `output_tokens`, not an addition to
   * it — a 28-output/27-thinking turn produced a two-token reply. Never
   * add the two together or every reasoning turn double-counts.
   */
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** `tool_info` on a tool step: the call, and its result once it lands. */
export interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: { type?: string; message?: string };
}

export type AgyStepState = "ACTIVE" | "DONE" | "ERROR";
export type AgyStepType =
  "user_input" | "agent_response" | "tool" | "checkpoint" | (string & {});

export interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: AgyStepState;
  step_type?: AgyStepType;
  tool_name?: string;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
  tool_info?: AgyToolInfo;
}

export interface AgyInit {
  cwd?: string;
  tools?: string[];
  permission_mode?: string;
  model?: string;
  agent?: string;
}

/** Terminal states the CLI reports on `result.status`. */
export type AgyResultStatus =
  | "SUCCESS"
  | "ERROR"
  | "CANCELED"
  | "INTERRUPTED"
  | "INVALID"
  | "WAITING"
  | "RUNNING";

export interface AgyResult {
  conversation_id?: string;
  status?: AgyResultStatus;
  response?: string;
  error?: string;
  duration_seconds?: number;
  /** Cumulative over the session in stream-json input mode, not per turn. */
  num_turns?: number;
  /** Cumulative over the session in stream-json input mode, not per turn. */
  usage?: AgyUsage;
  structured_output?: unknown;
}

export type AgyEvent =
  | { event: "init"; conversation_id?: string; init?: AgyInit }
  | { event: "step_update"; step_update?: AgyStepUpdate }
  | { event: "result"; result?: AgyResult };

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse one NDJSON line into an [AgyEvent], or null when the line is
 * blank, not JSON, or carries an `event` name this build doesn't know.
 *
 * Unknown event names are dropped rather than thrown on — the CLI's own
 * stdin protocol does the same in the other direction, precisely so a
 * newer CLI streaming a future event type doesn't crash the consumer.
 */
export function parseAgyLine(line: string): AgyEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const name = (parsed as { event?: unknown }).event;
  if (name !== "init" && name !== "step_update" && name !== "result") {
    return null;
  }
  return parsed as AgyEvent;
}

/** Parse a whole NDJSON document (a fixture, a captured run). */
export function parseAgyStream(text: string): AgyEvent[] {
  const events: AgyEvent[] = [];
  for (const line of text.split("\n")) {
    const event = parseAgyLine(line);
    if (event) events.push(event);
  }
  return events;
}

// ── Tool identity ───────────────────────────────────────────────────────────

/** A tool step reduced to the vocabulary the rest of Talon speaks. */
export interface AgyToolShape {
  /** Bare tool name — `check_time`, not `call_mcp_tool`. */
  name: string;
  /** MCP server the call was routed to, when it was an MCP call. */
  server?: string;
  input: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Unwrap a tool step into `{ name, server?, input }`.
 *
 * `call_mcp_tool` carries the real identity in its parameters
 * (`ServerName` / `ToolName` / `Arguments`); every other tool is a
 * native agy tool (`run_command`, `write_to_file`, `view_file`, …)
 * reported under its own name, exactly as codex reports
 * `command_execution` / `file_change`.
 */
export function describeAgyTool(step: AgyStepUpdate): AgyToolShape {
  const info = step.tool_info;
  const rawName = info?.name ?? step.tool_name ?? "unknown";
  if (rawName !== "call_mcp_tool") {
    return { name: rawName, input: asRecord(info?.parameters) };
  }
  const params = asRecord(info?.parameters);
  const toolName = typeof params.ToolName === "string" ? params.ToolName : "";
  const server =
    typeof params.ServerName === "string" ? params.ServerName : undefined;
  return {
    // A malformed call_mcp_tool (no ToolName) still has to report
    // something; falling back to the wrapper name keeps the
    // call→result pairing intact rather than emitting an empty id.
    name: toolName || rawName,
    ...(server ? { server } : {}),
    input: asRecord(params.Arguments),
  };
}

/** Stable per-turn id for a tool step, so start and end pair up. */
export function agyToolCallId(step: AgyStepUpdate): string {
  return `${step.conversation_id ?? "agy"}:${step.step_index ?? 0}`;
}

// ── Stream-state translation ────────────────────────────────────────────────

export interface AgyEventContext {
  state: StreamState;
  chatId: string;
  /** Tool call ids whose start was reported and await their terminal event. */
  startedToolIds: Set<string>;
  /** Tool call ids already settled — guards duplicate terminal events. */
  settledToolIds: Set<string>;
  toolMetrics: { count: number };
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onToolUse?: (
    toolName: string,
    input: Record<string, unknown>,
    meta?: { failed?: boolean },
  ) => void;
  onToolStart?: (
    callId: string,
    toolName: string,
    input: Record<string, unknown>,
  ) => void;
  onToolEnd?: (
    callId: string,
    toolName: string,
    meta?: { failed?: boolean },
  ) => void;
}

export function createAgyEventContext(
  state: StreamState,
  chatId: string,
  callbacks: Pick<
    AgyEventContext,
    "onStreamDelta" | "onToolUse" | "onToolStart" | "onToolEnd"
  > = {},
): AgyEventContext {
  return {
    state,
    chatId,
    startedToolIds: new Set<string>(),
    settledToolIds: new Set<string>(),
    toolMetrics: { count: 0 },
    ...callbacks,
  };
}

/**
 * Apply one `step_update` to the shared stream state.
 *
 * `init` and `result` are handled by the process layer (they carry the
 * conversation id and the turn's settlement), so this deals only with
 * the two step types that mutate a turn: `agent_response` text and
 * `tool` lifecycle. `user_input` and `checkpoint` steps are
 * bookkeeping and produce nothing.
 */
export function applyAgyStep(step: AgyStepUpdate, ctx: AgyEventContext): void {
  if (step.step_type === "agent_response") {
    applyAgentResponse(step, ctx);
    return;
  }
  if (step.step_type === "tool") applyToolStep(step, ctx);
}

function applyAgentResponse(step: AgyStepUpdate, ctx: AgyEventContext): void {
  const delta = step.text_delta;
  if (!delta) return;
  appendText(ctx.state, delta);
  if (!ctx.onStreamDelta) return;
  try {
    ctx.onStreamDelta(
      ctx.state.allResponseText + ctx.state.currentBlockText,
      "text",
    );
  } catch {
    /* non-fatal — a consumer bug must not kill the turn */
  }
}

function applyToolStep(step: AgyStepUpdate, ctx: AgyEventContext): void {
  const id = agyToolCallId(step);
  const shape = describeAgyTool(step);
  if (step.state === "ACTIVE") {
    openToolCall(ctx, id, shape);
    return;
  }
  if (step.state !== "DONE" && step.state !== "ERROR") return;
  if (ctx.settledToolIds.has(id)) return;
  ctx.settledToolIds.add(id);
  settleToolCall(ctx, id, shape, step);
}

function openToolCall(
  ctx: AgyEventContext,
  id: string,
  shape: AgyToolShape,
): void {
  if (ctx.startedToolIds.has(id) || !ctx.onToolStart) return;
  ctx.startedToolIds.add(id);
  try {
    ctx.onToolStart(id, shape.name, shape.input);
  } catch {
    /* non-fatal */
  }
}

function settleToolCall(
  ctx: AgyEventContext,
  id: string,
  shape: AgyToolShape,
  step: AgyStepUpdate,
): void {
  const failed = step.state === "ERROR" || Boolean(step.tool_info?.error);
  // Every call counts, failed or not — the Claude SDK backend counts
  // each tool_use block regardless of outcome, so agy must too or the
  // fleet-wide `tool_calls.*` keys silently undercount.
  recordToolCall(ctx.chatId, shape.name, "agy");
  ctx.toolMetrics.count += 1;

  if (failed) {
    const detail = step.tool_info?.error?.message;
    if (detail) {
      logWarn(
        "agent",
        `[${ctx.chatId}] agy tool ${shape.name} failed: ${detail}`,
      );
    }
    reportToolTerminal(ctx, id, shape, { failed: true });
    return;
  }

  // Only a successful call mutates delivery state: `recordToolUse`
  // captures the delivered-text norm and flips the terminator.
  recordToolUse(ctx.state, shape.name, shape.input);
  reportToolTerminal(ctx, id, shape);
  if (isTurnTerminator(shape.name, shape.input)) {
    log("agent", `[${ctx.chatId}] agy terminator fired: ${shape.name}`);
  }
}

function reportToolTerminal(
  ctx: AgyEventContext,
  id: string,
  shape: AgyToolShape,
  meta?: { failed?: boolean },
): void {
  if (ctx.startedToolIds.delete(id) && ctx.onToolEnd) {
    try {
      ctx.onToolEnd(id, shape.name, meta);
    } catch {
      /* non-fatal */
    }
    return;
  }
  if (!ctx.onToolUse) return;
  try {
    ctx.onToolUse(shape.name, shape.input, meta);
  } catch {
    /* non-fatal */
  }
}

// ── Usage ───────────────────────────────────────────────────────────────────

/** Talon's per-turn token shape, as read off an agy usage payload. */
export interface AgyTurnTokens {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

const nonNegative = (n: number | undefined): number => Math.max(0, n ?? 0);

/**
 * Map an agy usage payload onto Talon's counters.
 *
 * `thinking_tokens` is deliberately NOT added to `output_tokens`: the
 * CLI already counts reasoning inside output (28 output / 27 thinking
 * for a two-token reply), so summing them would double-charge every
 * reasoning turn. agy reports no cache writes, hence the constant 0 —
 * which is why the backend registers `cacheMetrics: "read"`.
 */
export function agyUsageToTokens(usage: AgyUsage | undefined): AgyTurnTokens {
  return {
    inputTokens: nonNegative(usage?.input_tokens),
    outputTokens: nonNegative(usage?.output_tokens),
    cacheRead: nonNegative(usage?.cache_read_tokens),
    cacheWrite: 0,
  };
}

/**
 * Difference two cumulative usage snapshots.
 *
 * In `--input-format stream-json` the `result.usage` counters are
 * cumulative over the whole session, so turn N's real cost is
 * `after - before`. Clamped at zero in case the CLI ever resets a
 * counter mid-session.
 */
export function agyUsageDelta(
  before: AgyTurnTokens | undefined,
  after: AgyTurnTokens,
): AgyTurnTokens {
  if (!before) return after;
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: 0,
  };
}
