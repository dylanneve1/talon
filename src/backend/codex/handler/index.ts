/**
 * Codex message handler.
 *
 * Split by responsibility:
 *   - `state`   — the in-flight abort registry (getActiveAbort)
 *   - `usage`   — CodexUsageExhaustedError + rollout usage-exhausted probe
 *   - `events`  — ThreadEvent/ThreadItem → shared stream-state translation
 *   - `message` — the handleMessage entry point + ChatGPT-OAuth fallback ladder
 *
 * Re-exports the same public surface the old single-file module exposed.
 */

export { handleMessage } from "./message.js";
export { getActiveAbort } from "./state.js";
export { CodexUsageExhaustedError } from "./usage.js";
