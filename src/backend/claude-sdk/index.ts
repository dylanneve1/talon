/**
 * Claude SDK backend — barrel re-export.
 *
 * All consumers import from this file; the implementation is split across
 * focused modules for readability and maintainability.
 */

export { initAgent, updateSystemPrompt } from "./state.js";
export { warmSession } from "./warm.js";
export { handleMessage, getActiveQuery } from "./handler.js";
export { buildMcpServers } from "./options.js";
export { supports1mContext, get1mContextModelId } from "./models.js";
