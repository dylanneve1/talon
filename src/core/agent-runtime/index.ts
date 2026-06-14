/**
 * Agent runtime — barrel for the primitives every backend, frontend,
 * and dispatcher consumer reads through. See `agent-runtime/README.md`
 * for the module map.
 *
 *   - `AgentEvent`     + helpers   (events.ts)
 *   - `ModelRef`       + helpers   (model-ref.ts)
 *   - `Backend` + capability interfaces + `composeBackend` (capabilities.ts)
 *   - `JsonStore<T>`                                       (store.ts)
 *   - Backend contract assertions                          (contract-tests.ts)
 */

export {
  type AgentEvent,
  type AgentError,
  type AgentErrorKind,
  type AgentResult,
  type UsageSnapshot,
  addUsage,
  AgentRunError,
  classifiedToAgentError,
  emptyUsage,
  isAgentEventOf,
  isAgentRunTerminator,
  toolInputToRecord,
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
  type Backend,
  type BackgroundRunner,
  type ChatBackend,
  type ChatRunParams,
  type ModelCatalog,
  type SessionBackend,
  type SystemControl,
  type ToolRefreshResult,
  type ToolRuntime,
  type UsageTelemetry,
  composeBackend,
} from "./capabilities.js";

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
