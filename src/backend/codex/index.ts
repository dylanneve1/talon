/**
 * Codex backend — barrel re-export.
 *
 * Wraps `@openai/codex-sdk` (which in turn spawns the `codex` CLI from
 * `@openai/codex`) and exposes a Backend-compatible API. The
 * implementation is split across focused modules:
 *
 *   - `constants.ts`   — system-prompt suffix, default model.
 *   - `state.ts`       — per-process state container.
 *   - `init.ts`        — backend init + lazy Codex-instance construction.
 *   - `mcp-config.ts`  — Talon MCP plugins → Codex `--config` TOML.
 *   - `handler.ts`     — main message handler (streaming, end_turn).
 *   - `factory.ts`     — registry registration.
 *
 * MCP integration: Codex configures MCP servers at thread-creation
 * time via TOML overrides. Talon rebuilds the `Codex` instance when
 * the active chat id changes so each chat sees its own MCP server
 * environment (frontend-tools + plugin servers).
 */

export {
  CODEX_SYSTEM_PROMPT_SUFFIX,
  CODEX_DEFAULT_MODEL,
  CODEX_DEFAULT_WORKING_DIRECTORY,
} from "./constants.js";

export { initCodexAgent, ensureCodex } from "./init.js";

export { handleMessage, getActiveAbort } from "./handler.js";

export { runOneShotAgent } from "./one-shot.js";

export { buildCodexMcpServers, type CodexMcpServer } from "./mcp-config.js";
