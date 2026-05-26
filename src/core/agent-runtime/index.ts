/**
 * Agent runtime — barrel for the primitives every backend, frontend,
 * and dispatcher consumer reads through. See `agent-runtime/README.md`
 * for the module map.
 *
 *   - `AgentEvent`     + helpers   (events.ts)
 *   - `ModelRef`       + helpers   (model-ref.ts)
 *   - `RunPolicy`      + defaults  (run-policy.ts)
 *   - `Backend` + capability interfaces + `composeBackend` (capabilities.ts)
 *   - `resolveActiveModelRefForChat`                      (resolver.ts)
 *   - `JsonStore<T>`                                       (store.ts)
 *   - Backend contract assertions                          (contract-tests.ts)
 *   - Event → legacy callback bridge                       (legacy-bridge.ts)
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
  type Backend,
  type BackendCapabilities,
  type BackgroundRunner,
  type ChatBackend,
  type ChatRunParams,
  type ModelCatalog,
  type ModelFilter,
  type ModelList,
  type ModelResolution,
  type ModelResolveContext,
  type SessionBackend,
  type SystemControl,
  type ToolRefreshResult,
  type ToolRuntime,
  type UsageTelemetry,
  composeBackend,
  deriveCapabilities,
} from "./capabilities.js";

export {
  type ActiveModelRefResolution,
  resolveActiveModelRefForChat,
  getActiveModelRefForChat,
} from "./resolver.js";

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
} from "./legacy-bridge.js";
