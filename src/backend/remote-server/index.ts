/**
 * Shared remote-server backend framework — barrel re-export.
 *
 * Helpers used by `backend/opencode` and `backend/kilo` (both wrap a
 * long-running upstream agent server that exposes a common HTTP API
 * for MCP registration, session lifecycle, tool listing, and provider
 * resolution).
 *
 * Architecture in four layers:
 *
 *   - {@link RemoteServerState} (state.ts) — per-backend mutable container.
 *     Each concrete backend owns one instance, holding the cached client,
 *     config, frontend label, gateway-port resolver, and the MCP /
 *     provider caches.
 *
 *   - Lifecycle / MCP / sessions / providers — pure helpers that take a
 *     `RemoteAgentClient` + `RemoteServerState` and act on them.
 *
 *   - Bindings (server-bindings.ts, chat-turn.ts, turn.ts, factory.ts) —
 *     the helpers closed over one backend's state, the SSE-driven turn,
 *     the chat-turn orchestration, and the registry factory composition.
 *     This is where the code that used to be copied per backend lives.
 *
 *   - Concrete backends (`backend/opencode`, `backend/kilo`) — a
 *     `RemoteBackendProfile` (SDK constructors, port, delivery contract,
 *     model-selection parser) plus re-exports under historical names.
 *
 * What's NOT here (intentionally):
 *
 *   - Tool definitions, frontend prompt format — those are backend-
 *     agnostic and live in `core/` and `backend/shared/`.
 *
 * This barrel exposes the helper layer for tests and the conformance
 * suite; the bindings modules import from the concrete files directly.
 */

export type { RemoteAgentClient } from "./client.js";

export { type RemoteServerState, createRemoteServerState } from "./state.js";

export { stopRemoteServer } from "./lifecycle.js";

export {
  TALON_MCP_SERVER_NAME,
  getChatMcpServerName,
  isTalonToolID,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  getRegisteredMcpServerNames,
} from "./mcp.js";
