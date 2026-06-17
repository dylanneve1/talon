/**
 * Kilo message handler.
 *
 * Split by responsibility:
 *   - `state`   — in-flight session registry (getActiveSession)
 *   - `turn`    — runKiloTurn + SSE subscription + last-assistant lookup
 *   - `message` — the handleMessage entry point + post-loop accounting
 *
 * Re-exports the same public surface the old single-file module exposed.
 */

export { handleMessage } from "./message.js";
export { getActiveSession } from "./state.js";
