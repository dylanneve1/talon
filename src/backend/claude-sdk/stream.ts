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
import { stripMcpPrefix } from "../../core/tools/index.js";
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
   * Per-token thinking chunks accumulated since the last throttled
   * flush — drained into a `reasoning` event when `processStreamDelta`
   * decides the throttle interval has elapsed.
   */
  unflushedThinkingDelta: string;

  // ── Delivery-tool argument streaming ───────────────────────────────────────
  // Talon's delivery contract makes assistant prose private scratchpad:
  // the user-visible reply is the `text` argument of `end_turn(...)` /
  // `send(type="text", ...)`. Streaming therefore tracks tool_use blocks:
  // as `input_json_delta` chunks arrive for a delivery tool we extract the
  // partial `text` field and emit it as `text_delta` events. Plain prose
  // deltas are NOT emitted (they'd leak scratchpad into the live preview).
  /** Type of the content block currently streaming (from content_block_start). */
  streamBlockType: "text" | "thinking" | "tool_use" | "other" | null;
  /** Tool name when the current streaming block is a tool_use block. */
  streamToolName: string | null;
  /** Accumulated partial JSON for the current tool_use block's input. */
  streamToolJson: string;
  /** Chars of the extracted `text` argument already emitted as deltas. */
  streamToolTextEmitted: number;
  /** Delivery blocks that streamed at least one chunk this turn (separator bookkeeping). */
  streamedDeliveryBlocks: number;
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
    unflushedThinkingDelta: "",
    streamBlockType: null,
    streamToolName: null,
    streamToolJson: "",
    streamToolTextEmitted: 0,
    streamedDeliveryBlocks: 0,
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

/** Bare names of bridge tools whose `text` argument is the user-visible reply. */
const DELIVERY_TOOL_NAMES = new Set(["end_turn", "send"]);

/**
 * Incrementally extract the `text` argument from a *partial* JSON tool
 * input string (the concatenation of `input_json_delta.partial_json`
 * chunks seen so far).
 *
 * Finds the first bare `"text"` key (inside JSON string values all
 * quotes are escaped, so a bare `"text":` token can only be a key) and
 * decodes the string value up to where the buffer currently ends —
 * handling standard escapes and `\uXXXX`. Incomplete trailing escapes
 * are left for the next call (we re-scan the full buffer each time;
 * tool args are small).
 */
export function extractStreamedTextArg(partialJson: string): string {
  const keyMatch = /"text"\s*:\s*"/.exec(partialJson);
  if (!keyMatch) return "";
  let i = keyMatch.index + keyMatch[0].length;
  let out = "";
  while (i < partialJson.length) {
    const c = partialJson[i];
    if (c === '"') break; // closing quote — value complete
    if (c === "\\") {
      if (i + 1 >= partialJson.length) break; // dangling escape — wait for more
      const n = partialJson[i + 1];
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === '"') out += '"';
      else if (n === "\\") out += "\\";
      else if (n === "/") out += "/";
      else if (n === "b") out += "\b";
      else if (n === "f") out += "\f";
      else if (n === "u") {
        const hex = partialJson.slice(i + 2, i + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break; // incomplete
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Drain any not-yet-emitted delivery-tool text for the current block.
 * Returns the suffix beyond what was already emitted (with a paragraph
 * separator when a previous delivery block already streamed this turn),
 * or `""` when there is nothing new.
 */
function drainDeliveryText(state: StreamState): string {
  if (
    state.streamBlockType !== "tool_use" ||
    !state.streamToolName ||
    !DELIVERY_TOOL_NAMES.has(stripMcpPrefix(state.streamToolName))
  ) {
    return "";
  }
  const extracted = extractStreamedTextArg(state.streamToolJson);
  if (extracted.length <= state.streamToolTextEmitted) return "";
  let out = extracted.slice(state.streamToolTextEmitted);
  if (state.streamToolTextEmitted === 0 && state.streamedDeliveryBlocks > 0) {
    // Second+ delivery message inside one turn (e.g. send → end_turn):
    // separate the previews so the draft doesn't mush them together.
    out = "\n\n" + out;
  }
  if (state.streamToolTextEmitted === 0) state.streamedDeliveryBlocks++;
  state.streamToolTextEmitted = extracted.length;
  return out;
}

function resetStreamBlock(state: StreamState): void {
  state.streamBlockType = null;
  state.streamToolName = null;
  state.streamToolJson = "";
  state.streamToolTextEmitted = 0;
}

/**
 * Process a streaming (partial-message) event.
 *
 * What streams, and why:
 *   - `thinking_delta` → throttled `reasoning` emits (drives spinners,
 *     never user-visible text).
 *   - `input_json_delta` on `end_turn` / `send` tool_use blocks → the
 *     partial `text` argument, throttle-emitted as `text` phase. This IS
 *     the user-visible reply under Talon's delivery contract, so it's
 *     the only thing that belongs in a live message preview.
 *   - plain `text_delta` (assistant prose) → accumulated for fallback
 *     bookkeeping but NEVER emitted: prose is private scratchpad
 *     (pre-tool segments are delivered later as complete progress
 *     messages; trailing prose is dropped). Streaming it live would
 *     leak scratchpad into the chat preview.
 *
 * Returns `null` when nothing should be emitted (not a relevant event,
 * or the throttle window is still open). The throttle keeps event volume
 * bounded — renderers re-accumulate at human-readable cadence.
 */
export function processStreamDelta(
  msg: SDKPartialAssistantMessage,
  state: StreamState,
): StreamDeltaEmit | null {
  // Subagent (Agent tool) streams replay through the parent session with
  // `parent_tool_use_id` set — their deltas are internal, never previewed.
  if (msg.parent_tool_use_id) return null;

  const event = msg.event;

  if (event.type === "content_block_start") {
    resetStreamBlock(state);
    const block = event.content_block;
    if (block.type === "tool_use") {
      state.streamBlockType = "tool_use";
      state.streamToolName = block.name;
    } else if (block.type === "text" || block.type === "thinking") {
      state.streamBlockType = block.type;
    } else {
      state.streamBlockType = "other";
    }
    return null;
  }

  if (event.type === "content_block_stop") {
    // Flush the remainder of a delivery-tool text arg regardless of the
    // throttle so the preview ends complete, then clear block state.
    const out = drainDeliveryText(state);
    resetStreamBlock(state);
    return out ? { phase: "text", text: out } : null;
  }

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
    // Scratchpad prose — accumulate for the result-message fallback but
    // do not emit (see docstring).
    state.currentBlockText += delta.text;
  } else if (delta.type === "input_json_delta") {
    if (state.streamBlockType !== "tool_use") return null;
    state.streamToolJson +=
      typeof (delta as { partial_json?: unknown }).partial_json === "string"
        ? (delta as { partial_json: string }).partial_json
        : "";
    const now = Date.now();
    if (now - state.lastStreamUpdate >= STREAM_INTERVAL) {
      const out = drainDeliveryText(state);
      if (out) {
        state.lastStreamUpdate = now;
        return { phase: "text", text: out };
      }
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
      }
      // Always reset — skipping the reset when blockText is whitespace-only
      // causes that whitespace to leak into the next text block's accumulation,
      // corrupting subsequent progress text and the final trailing-text value.
      blockText = "";
      state.currentBlockText = "";
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
