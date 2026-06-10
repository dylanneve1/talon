/**
 * Shared backend framework — barrel re-export.
 *
 * Helpers used by every concrete backend (`claude-sdk`, `kilo`, `opencode`)
 * to keep behaviour aligned and avoid copy-paste drift.
 *
 * What's here:
 *   - `delivered-text` — scratchpad/dedup primitives.
 *   - `flow-violation` — flow-violation detection + reminder text.
 *   - `prompt-format` — user-prompt formatter ([time] [Name] [msg_id:N]).
 *   - `session-name` — first-message → short session title.
 *   - `usage` — cache-hit % + log summarisers.
 *   - `system-prompt` — first-turn rebuild + backend suffix.
 *   - `model-retry` — session-expiry / context-overflow / fallback decisions.
 *   - `stream-state` — backend-agnostic accumulator for stream loops.
 *
 * What's NOT here (intentionally):
 *   - SDK-specific event types — those live in each backend.
 *   - Session storage — that's `src/storage/sessions.ts`.
 *   - MCP server registration — backend-specific transport details.
 */

export {
  normalizeForDedupe,
  isDuplicateOfDelivered,
  captureDeliveredText,
} from "./delivered-text.js";

export {
  FLOW_VIOLATION_REMINDER,
  FLOW_VIOLATION_MAX_RETRIES,
  detectFlowViolation,
  type FlowViolationInputs,
  type FlowViolationResult,
} from "./flow-violation.js";

export { formatUserPrompt, type PromptFormatInputs } from "./prompt-format.js";

export { extractSessionName } from "./session-name.js";

export {
  cacheHitPercent,
  summarizeUsage,
  type TokenUsageSnapshot,
} from "./usage.js";

export {
  prepareSystemPrompt,
  appendBackendSuffix,
  clearSystemPromptSnapshots,
  type PrepareSystemPromptInputs,
  type PreparedSystemPrompt,
} from "./system-prompt.js";

export {
  classifyRetry,
  type RetryDecision,
  type ClassifyRetryInputs,
} from "./model-retry.js";

export {
  createStreamState,
  appendText,
  closeCurrentSegment,
  recordToolUse,
  recordTokens,
  finalizeResponseText,
  type StreamState,
} from "./stream-state.js";

export {
  routeDelivery,
  buildDeliveryFailureReminder,
  TextBlockDeliveryError,
  type DeliveryRoute,
  type DeliveryDecision,
  type RouteDeliveryInputs,
} from "./delivery.js";

export { sleep } from "./sleep.js";

export {
  applyRetryDecision,
  type ApplyRetryDecisionInputs,
  type ApplyRetryDecisionResult,
} from "./handle-retry.js";
