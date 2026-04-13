/**
 * Claude SDK backend — barrel re-export.
 *
 * All consumers import from this file; the implementation is split across
 * focused modules for readability and maintainability.
 */

export { initAgent, updateSystemPrompt } from "./state.js";
export { warmSession } from "./warm.js";
export { handleMessage } from "./handler.js";
