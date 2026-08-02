/**
 * Shared remote-server backend framework — barrel re-export.
 *
 * Helpers used by `backend/opencode` and `backend/kilo` (both wrap a
 * long-running upstream agent server that exposes a common HTTP API
 * for MCP registration, session lifecycle, tool listing, and provider
 * resolution).
 *
 * Architecture in three layers:
 *
 *   - {@link RemoteServerState} (state.ts) — per-backend mutable container.
 *     Each concrete backend owns one instance, holding the cached client,
 *     config, frontend label, gateway-port resolver, and the MCP /
 *     provider caches.
 *
 *   - Lifecycle / MCP / sessions / providers — pure helpers that take a
 *     `RemoteAgentClient` + `RemoteServerState` and act on them.
 *
 *   - Concrete backends (`backend/opencode`, `backend/kilo`) — supply
 *     the SDK-specific client and server factories, the prompt /
 *     promptAsync drivers, and the system-prompt suffix.
 *
 * What's NOT here (intentionally):
 *
 *   - SDK-specific event types (Kilo's SSE events, OpenCode's sync
 *     `prompt` parts list) — those stay in each backend.
 *   - Per-backend model catalog logic (`models.ts`) — Kilo and OpenCode
 *     have different bucket priorities, fuzzy-match weights, etc.
 *   - Tool definitions, frontend prompt format — those are backend-
 *     agnostic and live in `core/` and `backend/shared/`.
 */

export type {
  RemoteAgentClient,
  RemoteMcpServerConfig,
  RemotePermissionRule,
} from "./client.js";

export {
  type RemoteServerState,
  type RemoteServerStateInputs,
  createRemoteServerState,
  errMsg,
} from "./state.js";

export {
  type EnsureRemoteServerInputs,
  ensureRemoteServer,
  stopRemoteServer,
} from "./lifecycle.js";

export {
  TALON_MCP_SERVER_NAME,
  TALON_PLUGIN_MCP_SERVER_NAME,
  getChatMcpServerName,
  getPluginMcpServerName,
  safeMcpNamePart,
  isTalonToolID,
  ensureChatMcpServer,
  ensurePluginMcpServers,
  buildToolOverrides,
  disconnectChatMcpServer,
  refreshPluginMcpServers,
  getRegisteredMcpServerNames,
} from "./mcp.js";

export {
  buildPermissionRuleset,
  ensureRemoteSession,
  warmRemoteSession,
  type RemoteWarmDeps,
} from "./sessions.js";

export { type ProviderResolverHooks, resolveProviderID } from "./providers.js";

export {
  RemoteTurnTimeoutError,
  remoteTurnTimeoutMs,
  awaitRemoteTurn,
} from "./turn-timeout.js";
