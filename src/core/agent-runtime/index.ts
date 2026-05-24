/**
 * Agent runtime — Phase 1 type-only surface.
 *
 * See `docs/talon-architecture-unification-plan.md` for the full
 * design. This barrel re-exports the canonical shapes:
 *
 *   - `AgentEvent` + helpers (events.ts)
 *   - `ModelRef`   + helpers (model-ref.ts)
 *   - `RunPolicy`  + defaults (run-policy.ts)
 *   - `ToolDescriptor`       (tool-descriptor.ts)
 *   - Capability interfaces  (capabilities.ts)
 *   - `adaptQueryBackend`    (adapter.ts)
 *
 * Phase 1 does NOT change runtime behaviour — no production caller
 * imports from here yet. Adding `import { ... } from "../core/agent-
 * runtime/index.js"` in a downstream module is the explicit opt-in.
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
