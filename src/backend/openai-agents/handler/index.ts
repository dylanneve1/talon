/**
 * OpenAI Agents message handler.
 *
 * Split by responsibility (parallel to the codex handler/ layout):
 *   - `state`   — in-flight abort registry (getActiveAbort)
 *   - `events`  — RunItemStreamEvent → shared stream-state translation
 *   - `message` — the handleMessage entry point + flow-violation retry
 *
 * Re-exports the same public surface the old single-file module exposed.
 */

export { handleMessage } from "./message.js";
export { getActiveAbort } from "./state.js";
