/**
 * OpenCode message handler.
 *
 * Split by responsibility (parallel to the kilo handler/ layout):
 *   - `state`   — in-flight session registry (activeSessions)
 *   - `turn`    — runOpenCodeTurn + SSE subscription + last-assistant lookup
 *   - `message` — the handleMessage entry point + post-loop accounting
 *
 * Re-exports the same public surface the old single-file module exposed.
 */

export { handleMessage } from "./message.js";
