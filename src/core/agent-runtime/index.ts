/**
 * Agent runtime — unified surface for the architecture-unification
 * plan. See `agent-runtime/README.md` for the current phase status
 * and migration cookbook. This barrel re-exports the canonical
 * shapes:
 *
 *   - `AgentEvent` + helpers       (events.ts)
 *   - `ModelRef`   + helpers       (model-ref.ts)
 *   - `RunPolicy`  + defaults      (run-policy.ts)
 *   - `ToolDescriptor`             (tool-descriptor.ts)
 *   - Capability interfaces        (capabilities.ts)
 *   - `adaptQueryBackend`          (adapter.ts)
 *   - `resolveActiveModelRefForChat` (resolver.ts)
 *   - `ToolRegistry`               (tool-registry.ts)
 *   - `JsonStore<T>`               (store.ts) — used by every storage module
 *   - Backend contract assertions  (contract-tests.ts)
 *   - Event ↔ legacy callback bridge (legacy-bridge.ts)
 *   - `AgentEventLogRenderer`      (event-log-renderer.ts)
 */

export {
  type AgentEvent,
  type AgentError,
  type AgentErrorKind,
  type AgentResult,
  type UsageSnapshot,
  addUsage,
  emptyUsage,
  isAgentEventOf,
  isAgentRunTerminator,
} from "./events.js";

export {
  type BackendId,
  type CacheSupport,
  type ModelRef,
  type ModelSource,
  BACKEND_IDS,
  isBackendId,
  makeBareModelRef,
  sameModelRef,
} from "./model-ref.js";

export {
  type DeliveryPolicy,
  type LoggingPolicy,
  type PermissionPolicy,
  type RunKind,
  type RunPolicy,
  type SessionPolicy,
  type TimeoutPolicy,
  type ToolPolicy,
  allowsDelivery,
  defaultRunPolicyFor,
  requiresAmbientChat,
} from "./run-policy.js";

export {
  type ToolDescriptor,
  type ToolFilter,
  applyToolFilter,
} from "./tool-descriptor.js";

export {
  type Backend,
  type BackendCapabilities,
  type BackgroundRunner,
  type BackgroundRunParams,
  type ChatBackend,
  type ChatRunParams,
  type ModelCatalog,
  type ModelFilter,
  type ModelList,
  type ModelResolution,
  type ModelResolveContext,
  type SessionBackend,
  type ToolRefreshResult,
  type ToolRuntime,
  type UsageTelemetry,
  deriveCapabilities,
} from "./capabilities.js";

export { type AdapterOptions, adaptQueryBackend } from "./adapter.js";

export {
  type ActiveModelRefResolution,
  resolveActiveModelRefForChat,
  getActiveModelRefForChat,
} from "./resolver.js";

export {
  adaptInstantiatedBackend,
  adaptOneBackend,
  getAdaptedBackends,
} from "./registry.js";

export {
  ToolRegistry,
  ToolRegistryError,
  groupToolsByServer,
  parseMcpToolId,
} from "./tool-registry.js";

export { type JsonStoreFs, type JsonStoreOptions, JsonStore } from "./store.js";

export {
  assertBackendContract,
  assertBackendIdentity,
  assertBackgroundRunnerLifecycle,
  assertChatBackendEmitsRunStarted,
  assertChatBackendEmitsSingleUsage,
  assertChatBackendTerminates,
  assertCompletedUsageMatchesUsageEvent,
  assertModelCatalogDefaultShape,
  assertUsageTelemetryShape,
} from "./contract-tests.js";

export {
  BridgedAgentError,
  type LegacyCallbacks,
  pipeEventsToCallbacks,
  reduceEventsToResult,
} from "./legacy-bridge.js";

export {
  freshRenderState,
  LogRendererError,
  type LogSink,
  type RenderState,
  renderEvent,
  streamLog,
} from "./event-log-renderer.js";
