/**
 * Backend runtime library — barrel re-export.
 *
 * Helpers used by every concrete backend (`claude-sdk`, `codex`,
 * `kilo`, `opencode`, `openai-agents`) to keep behaviour aligned and
 * avoid copy-paste drift. The modules sit in three groups — `turn/`
 * (what a turn does once the SDK loop is running), `prompt/` (the text
 * handed to the model) and `cache/` (prompt-cache telemetry) — with the
 * cross-cutting vocabulary (`usage`, `metrics`, `frontends`, `sleep`)
 * at the root beside this barrel.
 *
 * What's here:
 *   - `turn/delivered-text` — scratchpad/dedup primitives.
 *   - `prompt/delivery-contract` — per-backend response-flow contract
 *     (rendered from prompts/system templates), frontend-aware
 *     flow-violation reminder, first-turn nudge.
 *   - `turn/flow-violation` — flow-violation detection + reminder text.
 *   - `metrics` — the shared metric vocabulary (tool calls, per-turn
 *     rollups, flow violations) with backend dimensions.
 *   - `prompt/prompt-format` — user-prompt formatter
 *     ([time] [Name] [msg_id:N]).
 *   - `frontends` — config `frontend` → messaging-frontend list.
 *   - `extractSessionName` — re-exported from `util/session-name` so the
 *     backends keep one import site; the helper itself is frontend-neutral.
 *   - `usage` — cache-hit % + log summarisers.
 *   - `prompt/system-prompt` — per-session prompt snapshots + backend
 *     suffix (assembly itself lives in `core/prompt/`).
 *   - `turn/model-retry` — session-expiry / context-overflow / fallback
 *     decisions.
 *   - `turn/stream-state` — backend-agnostic accumulator for stream loops.
 *   - `turn/turn-interrupt` — user-driven mid-turn interrupt registry (the
 *     shared `ChatBackend.interruptChatTurn` for callback backends).
 *   - `turn/turn-phases` — the post-stream phases (accounting, session name,
 *     trailing-prose contract, result tail) every handler runs.
 *
 * What's NOT here (intentionally):
 *   - SDK-specific event types — those live in each backend.
 *   - Session storage — that's `src/storage/sessions.ts`.
 *   - MCP server registration — backend-specific transport details
 *     (the spawn/env contract they share is `core/tools/mcp-env.ts`).
 */

export { captureDeliveredText } from "./turn/delivered-text.js";

export { registerTurnInterrupt } from "./turn/turn-interrupt.js";

export { formatUserPrompt } from "./prompt/prompt-format.js";

export {
  buildDeliveryContract,
  buildFlowViolationReminder,
  buildFirstTurnReminder,
} from "./prompt/delivery-contract.js";

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
} from "./cache/cache-telemetry.js";

export {
  prepareSystemPrompt,
  appendBackendSuffix,
} from "./prompt/system-prompt.js";

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
} from "./turn/stream-state.js";

export {
  routeDelivery,
  buildDeliveryFailureReminder,
  TextBlockDeliveryError,
} from "./turn/delivery.js";

export { sleep } from "./sleep.js";

export { recordToolCall } from "./metrics.js";

export { applyRetryDecision } from "./turn/handle-retry.js";

export {
  accountTurn,
  accountFailedTurn,
  nameSessionFromFirstMessage,
  enforceTrailingProse,
  finishCallbackTurn,
  turnUsageSnapshot,
} from "./turn/turn-phases.js";

export { buildResultEvents } from "./turn/result-events.js";
