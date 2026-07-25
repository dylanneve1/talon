/**
 * Shared backend framework — barrel re-export.
 *
 * Helpers used by every concrete backend (`claude-sdk`, `codex`,
 * `kilo`, `opencode`, `openai-agents`) to keep behaviour aligned and
 * avoid copy-paste drift.
 *
 * What's here:
 *   - `delivered-text` — scratchpad/dedup primitives.
 *   - `delivery-contract` — per-backend response-flow contract
 *     (rendered from prompts/system templates), frontend-aware
 *     flow-violation reminder, first-turn nudge.
 *   - `flow-violation` — flow-violation detection + reminder text.
 *   - `metrics` — the shared metric vocabulary (tool calls, per-turn
 *     rollups, flow violations) with backend dimensions.
 *   - `prompt-format` — user-prompt formatter ([time] [Name] [msg_id:N]).
 *   - `frontends` — config `frontend` → messaging-frontend list.
 *   - `extractSessionName` — re-exported from `util/session-name` so the
 *     backends keep one import site; the helper itself is frontend-neutral.
 *   - `usage` — cache-hit % + log summarisers.
 *   - `system-prompt` — per-session prompt snapshots + backend suffix
 *     (assembly itself lives in `core/prompt/`).
 *   - `model-retry` — session-expiry / context-overflow / fallback decisions.
 *   - `stream-state` — backend-agnostic accumulator for stream loops.
 *   - `turn-interrupt` — user-driven mid-turn interrupt registry (the
 *     shared `ChatBackend.interruptChatTurn` for callback backends).
 *
 * What's NOT here (intentionally):
 *   - SDK-specific event types — those live in each backend.
 *   - Session storage — that's `src/storage/sessions.ts`.
 *   - MCP server registration — backend-specific transport details
 *     (the spawn/env contract they share is `core/tools/mcp-env.ts`).
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

export { registerTurnInterrupt, interruptChatTurn } from "./turn-interrupt.js";

export { formatUserPrompt, type PromptFormatInputs } from "./prompt-format.js";

export {
  buildDeliveryContract,
  buildFlowViolationReminder,
  buildFirstTurnReminder,
  deliveryToolsForFrontend,
  registerFrontendDeliveryTools,
  type DeliveryMode,
  type DeliveryToolNames,
} from "./delivery-contract.js";

export { extractSessionName } from "../../util/session-name.js";

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
  pushLiveUsage,
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

export { nonTerminalFrontends } from "./frontends.js";

export {
  recordToolCall,
  recordTurnMetrics,
  recordFailedTurnAccounting,
  recordFlowViolation,
  type TurnMetricInputs,
} from "./metrics.js";

export {
  applyRetryDecision,
  type ApplyRetryDecisionInputs,
  type ApplyRetryDecisionResult,
} from "./handle-retry.js";
