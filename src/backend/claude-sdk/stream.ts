/**
 * Typed stream processing helpers for SDK messages.
 *
 * Each function operates on a properly narrowed SDK message type —
 * no Record<string, unknown> casts. The StreamState accumulator
 * replaces the scattered local variables from the original handler.
 */

import type {
  SDKMessage,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BetaRawContentBlockDeltaEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { STREAM_INTERVAL } from "./constants.js";
import { log } from "../../util/log.js";

// ── Stream state accumulator ────────────────────────────────────────────────

/** Mutable state accumulated while iterating the SDK message stream. */
export type StreamState = {
  currentBlockText: string;
  allResponseText: string;
  newSessionId: string | undefined;
  toolCalls: number;
  contextTokens: number;
  contextWindow: number | undefined;
  numApiCalls: number;
  sdkInputTokens: number;
  sdkOutputTokens: number;
  sdkCacheRead: number;
  sdkCacheWrite: number;
  lastStreamUpdate: number;
  /**
   * Trailing text from the most recent assistant message — text after all
   * tool_use blocks (or the full text when no tools were called). NOT
   * delivered to the user (the output stream is private scratchpad by
   * contract). Tracked so the handler can log a diagnostic when the model
   * wrote prose without routing it through `end_turn` / `send` — surfaces
   * missed end_turn calls in metrics rather than silently dropping content.
   */
  lastTrailingText: string;
  /**
   * Normalized text args observed on `end_turn` / `send(type="text")` tool
   * calls during this turn. Cross-tool dedup: if both fire with similar
   * content (e.g. model calls both with the same text mid-turn), the
   * second one can be matched against this list to avoid the user seeing
   * the same message twice. Also used to silence the trailing-prose
   * diagnostic when the prose just duplicates what was already delivered.
   */
  deliveredTextNorms: string[];
  /**
   * Set when a tool with `endsTurn: true` (e.g. `end_turn`) was observed
   * in this turn. Once true, the handler invokes `qi.interrupt()` to abort
   * the SDK loop cleanly — the model can't produce more trailing scratchpad
   * after this point. Also gates the flow-violation re-prompt: if the model
   * explicitly ended its turn, we don't re-prompt for trailing prose that
   * may have appeared in the same assistant message before the terminator.
   */
  turnTerminated: boolean;
  /**
   * Per-token text chunks accumulated since the last throttled flush.
   * Drained into a `text_delta` event when `processStreamDelta` decides
   * the throttle interval has elapsed.
   */
  unflushedTextDelta: string;
  /**
   * Same as `unflushedTextDelta` but for thinking-phase tokens — drained
   * into a `reasoning` event. Tracked separately so a thinking burst
   * doesn't poison the visible-text delta buffer.
   */
  unflushedThinkingDelta: string;
};

export function createStreamState(): StreamState {
  return {
    currentBlockText: "",
    allResponseText: "",
    newSessionId: undefined,
    toolCalls: 0,
    contextTokens: 0,
    contextWindow: undefined,
    numApiCalls: 0,
    sdkInputTokens: 0,
    sdkOutputTokens: 0,
    sdkCacheRead: 0,
    sdkCacheWrite: 0,
    lastStreamUpdate: 0,
    lastTrailingText: "",
    deliveredTextNorms: [],
    turnTerminated: false,
    unflushedTextDelta: "",
    unflushedThinkingDelta: "",
  };
}

// ── Type guards ─────────────────────────────────────────────────────────────

export function isSystemInit(msg: SDKMessage): msg is SDKSystemMessage {
  return msg.type === "system" && msg.subtype === "init";
}

export function isStreamEvent(
  msg: SDKMessage,
): msg is SDKPartialAssistantMessage {
  return msg.type === "stream_event";
}

export function isAssistant(msg: SDKMessage): msg is SDKAssistantMessage {
  return msg.type === "assistant";
}

export function isResult(msg: SDKMessage): msg is SDKResultMessage {
  return msg.type === "result";
}

// ── Message processors ──────────────────────────────────────────────────────

/** Output of `processStreamDelta` when the throttle interval has elapsed. */
export type StreamDeltaEmit =
  | { phase: "text"; text: string }
  | { phase: "thinking"; text: string };

/**
 * Process a streaming delta event — accumulates per-token chunks
 * into `state.currentBlockText` (text) / unflushed buffers, and
 * returns the chunk to emit when the throttle interval has elapsed.
 *
 * Returns `null` when nothing should be emitted yet (either the delta
 * wasn't a content-block-delta, or the throttle window is still open).
 * Callers yield a `text_delta` / `reasoning` event with the returned
 * `text`. The throttle keeps the event volume bounded — Telegram /
 * terminal renderers re-accumulate, but at human-readable cadence.
 */
export function processStreamDelta(
  msg: SDKPartialAssistantMessage,
  state: StreamState,
): StreamDeltaEmit | null {
  const event = msg.event;
  if (event.type !== "content_block_delta") return null;

  const deltaEvent = event as BetaRawContentBlockDeltaEvent;
  const delta = deltaEvent.delta;

  if (delta.type === "thinking_delta") {
    // The SDK's typed thinking_delta carries `.thinking`; treat
    // missing/non-string defensively so a schema drift can't crash
    // the loop.
    const chunk =
      typeof (delta as { thinking?: unknown }).thinking === "string"
        ? (delta as { thinking: string }).thinking
        : "";
    if (chunk) state.unflushedThinkingDelta += chunk;
    const now = Date.now();
    if (now - state.lastStreamUpdate >= STREAM_INTERVAL) {
      state.lastStreamUpdate = now;
      const out = state.unflushedThinkingDelta;
      state.unflushedThinkingDelta = "";
      if (out.length > 0) return { phase: "thinking", text: out };
    }
  } else if (delta.type === "text_delta") {
    state.currentBlockText += delta.text;
    state.unflushedTextDelta += delta.text;
    const now = Date.now();
    if (now - state.lastStreamUpdate >= STREAM_INTERVAL) {
      state.lastStreamUpdate = now;
      const out = state.unflushedTextDelta;
      state.unflushedTextDelta = "";
      if (out.length > 0) return { phase: "text", text: out };
    }
  }
  return null;
}

/** A tool call extracted from an assistant message. */
export type ToolCall = {
  name: string;
  input: Record<string, unknown>;
};

/** Result of processing an assistant message. */
export type AssistantResult = {
  /** Text segments accumulated before tool calls, each to be sent as a progress message. */
  progressTexts: string[];
  /** Tool calls found in the message. */
  tools: ToolCall[];
  /** Trailing text after all tool calls (or the full text if no tool calls). */
  trailingText: string;
};

/**
 * Process a complete assistant message — extracts text blocks and tool calls.
 * Uses the typed BetaContentBlock discriminated union.
 *
 * When multiple tool_use blocks appear in the same message with text before
 * each, every text segment is captured in progressTexts so the handler can
 * emit them all in order.
 */
export function processAssistantMessage(
  msg: SDKAssistantMessage,
  state: StreamState,
): AssistantResult {
  const content = msg.message.content;
  const tools: ToolCall[] = [];
  const progressTexts: string[] = [];
  let blockText = "";

  for (const block of content) {
    if (block.type === "text") {
      blockText += block.text;
    }
    if (block.type === "tool_use") {
      state.toolCalls++;
      const input =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      tools.push({ name: block.name, input });
      // Text before this tool call is a progress message
      if (blockText.trim()) {
        progressTexts.push(blockText.trim());
        state.allResponseText += blockText;
        blockText = "";
        state.currentBlockText = "";
      }
    }
  }

  // Remaining text after all tool calls (or if no tool calls)
  const trailingText = blockText.trim() ? blockText : "";
  if (trailingText) {
    state.currentBlockText = blockText;
  }

  return { progressTexts, tools, trailingText };
}

/**
 * Process the final result message — extracts token counts, context info,
 * and API call counts from the typed SDK result.
 */
export function processResultMessage(
  msg: SDKResultMessage,
  state: StreamState,
  sdkModel: string,
): void {
  state.numApiCalls = msg.num_turns ?? 0;

  // Context fill from last API iteration
  const usage = msg.usage;
  if (usage && Array.isArray(usage.iterations) && usage.iterations.length > 0) {
    const last = usage.iterations[usage.iterations.length - 1];
    state.contextTokens =
      (last.input_tokens ?? 0) +
      (last.cache_read_input_tokens ?? 0) +
      (last.cache_creation_input_tokens ?? 0);
  }

  // Read token counts from the ACTIVE model's usage only.
  // modelUsage is keyed by the exact SDK model string (e.g. "sonnet[1m]")
  // and contains cumulative session totals per model — summing all entries
  // double-counts when switching models mid-session.
  const modelUsage: Record<string, ModelUsage> = msg.modelUsage;
  const mu = modelUsage[sdkModel] ?? Object.values(modelUsage).at(-1);
  if (mu) {
    state.sdkInputTokens = mu.inputTokens ?? 0;
    state.sdkOutputTokens = mu.outputTokens ?? 0;
    state.sdkCacheRead = mu.cacheReadInputTokens ?? 0;
    state.sdkCacheWrite = mu.cacheCreationInputTokens ?? 0;
    if (mu.contextWindow > 0) {
      state.contextWindow = mu.contextWindow;
    }
  }

  log(
    "agent",
    `SDK result: sdkModel=${sdkModel}, contextWindow=${state.contextWindow}, contextTokens=${state.contextTokens}, numApiCalls=${state.numApiCalls}`,
  );

  // Fallback: if no text was captured via streaming or assistant messages,
  // pull from the result string (available on success results).
  if (
    !state.allResponseText &&
    !state.currentBlockText &&
    "result" in msg &&
    typeof msg.result === "string"
  ) {
    state.currentBlockText = msg.result;
  }
}

// ── Trailing-text fallback dedup ────────────────────────────────────────────
// Re-export from shared so legacy imports do not grow a second implementation.
export {
  normalizeForDedupe,
  isDuplicateOfDelivered,
} from "../shared/delivered-text.js";
