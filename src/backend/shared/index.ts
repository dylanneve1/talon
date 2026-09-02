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

export { captureDeliveredText } from "./delivered-text.js";

export {
  FLOW_VIOLATION_MAX_RETRIES,
  detectFlowViolation,
} from "./flow-violation.js";

export { registerTurnInterrupt } from "./turn-interrupt.js";

export { formatUserPrompt } from "./prompt-format.js";

export {
  buildDeliveryContract,
  buildFlowViolationReminder,
  buildFirstTurnReminder,
} from "./delivery-contract.js";

export { extractSessionName } from "../../util/session-name.js";

export { summarizeUsage } from "./usage.js";

// Only what is consumed THROUGH the barrel. Everything else in
// cache-telemetry.ts is imported from the module directly, matching the
// barrel discipline the prompt/ barrel was just trimmed to.
export {
  formatTurnCache,
  crossTurnVerdict,
  priorLookbackOverflow,
  noteLookbackRisk,
  CACHE_LOOKBACK_BLOCKS,
} from "./cache-telemetry.js";

export { prepareSystemPrompt, appendBackendSuffix } from "./system-prompt.js";

export { classifyRetry } from "./model-retry.js";

export {
  createStreamState,
  appendText,
  closeCurrentSegment,
  markProgressDelivered,
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
} from "./delivery.js";

export { sleep } from "./sleep.js";

export {
  recordToolCall,
  recordTurnMetrics,
  recordFailedTurnAccounting,
  recordFlowViolation,
} from "./metrics.js";

export { applyRetryDecision } from "./handle-retry.js";
