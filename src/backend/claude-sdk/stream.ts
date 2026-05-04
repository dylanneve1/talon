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

/**
 * Process a streaming delta event — accumulates text and fires throttled
 * callbacks for thinking and text phases.
 */
export function processStreamDelta(
  msg: SDKPartialAssistantMessage,
  state: StreamState,
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void,
): void {
  if (!onStreamDelta) return;

  const event = msg.event;
  if (event.type !== "content_block_delta") return;

  const deltaEvent = event as BetaRawContentBlockDeltaEvent;
  const delta = deltaEvent.delta;

  if (delta.type === "thinking_delta") {
    const now = Date.now();
    if (now - state.lastStreamUpdate >= STREAM_INTERVAL) {
      state.lastStreamUpdate = now;
      onStreamDelta(state.currentBlockText, "thinking");
    }
  } else if (delta.type === "text_delta") {
    state.currentBlockText += delta.text;
    const now = Date.now();
    if (now - state.lastStreamUpdate >= STREAM_INTERVAL) {
      state.lastStreamUpdate = now;
      onStreamDelta(state.currentBlockText, "text");
    }
  }
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

/**
 * Normalize text for fuzzy comparison — trim, lowercase, collapse whitespace,
 * strip emoji. Used to detect whether trailing prose duplicates content
 * already delivered via `end_turn` / `send(type="text")`.
 */
export function normalizeForDedupe(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MIN_DEDUP_LENGTH = 10;

/**
 * Returns true if `candidate` is substantively the same as any text in
 * `deliveredNorms`. "Substantively" = one is a substring of the other after
 * normalization; both must be at least MIN_DEDUP_LENGTH chars to avoid
 * dropping short legitimate replies.
 */
export function isDuplicateOfDelivered(
  candidate: string,
  deliveredNorms: string[],
): boolean {
  if (deliveredNorms.length === 0) return false;
  const norm = normalizeForDedupe(candidate);
  if (norm.length < MIN_DEDUP_LENGTH) return false;
  return deliveredNorms.some(
    (d) =>
      d.length >= MIN_DEDUP_LENGTH && (norm.includes(d) || d.includes(norm)),
  );
}
