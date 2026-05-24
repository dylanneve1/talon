/**
 * Adapter — wrap the legacy `QueryBackend` as the new `Backend`
 * composed object.
 *
 * Phase 1 contract: **no production caller invokes the adapter
 * yet.** The adapter exists so callers can begin migrating against
 * the new shape without churning every backend implementation in
 * the same PR. When the dispatcher migrates (Phase 3+), it will
 * call `adaptQueryBackend(legacy, id, label)` until each backend
 * grows a native `Backend`-shaped factory.
 *
 * Translation rules (deliberate fidelity over richness):
 *
 *   - `runChatTurn` synthesises a minimal event sequence around
 *     `query()`: `run_started` → `assistant_message` →
 *     `usage` → `completed`. No per-token streaming, no
 *     tool-call events. Phase 3 backends emit those natively.
 *
 *   - `runBackgroundTask` wraps `runOneShotAgent()`. The legacy
 *     method already writes its own markdown log via `appendLog`;
 *     the adapter routes those writes through a caller-supplied
 *     `logSink` and yields `run_started` / `completed` /
 *     `error` events.
 *
 *   - `ModelCatalog.{resolveModel, listModels, getDefaultModel}`
 *     adapts `UnifiedModelInfo` → `ModelRef` by carrying the
 *     legacy fields verbatim and tagging `source: "discovered"`
 *     (or `"backend-default"` for canonicals).
 *
 *   - `cacheSupport` is propagated from the backend's
 *     `cacheMetrics` field onto every `ModelRef` the adapter
 *     produces.
 */

import type {
  CacheMetricsSupport,
  OneShotAgentParams,
  QueryBackend,
  QueryParams,
  QueryResult,
  UnifiedModelInfo,
  UnifiedModelResolution,
} from "../types.js";
import type {
  Backend,
  BackgroundRunner,
  BackgroundRunParams,
  ChatBackend,
  ChatRunParams,
  ModelCatalog,
  ModelFilter,
  ModelList,
  ModelResolution,
  ModelResolveContext,
  SessionBackend,
  ToolRefreshResult,
  ToolRuntime,
  UsageTelemetry,
} from "./capabilities.js";
import { deriveCapabilities } from "./capabilities.js";
import {
  emptyUsage,
  type AgentError,
  type AgentErrorKind,
  type AgentEvent,
  type AgentResult,
  type UsageSnapshot,
} from "./events.js";
import {
  BACKEND_IDS,
  isBackendId,
  makeBareModelRef,
  type BackendId,
  type CacheSupport,
  type ModelRef,
  type ModelSource,
} from "./model-ref.js";

/**
 * Optional dependencies the adapter accepts at construction time.
 * All fields default to no-op behaviour — pass them only when
 * tests or callers need to observe legacy-side effects.
 */
export interface AdapterOptions {
  /**
   * Receives every `appendLog` call the underlying
   * `runOneShotAgent` makes. Defaults to a no-op so plain adapter
   * use doesn't leak markdown into the event stream.
   */
  logSink?: (text: string) => Promise<void> | void;
  /**
   * Source tag stamped onto every `ModelRef` the adapter produces.
   * Defaults to `"discovered"` because the only thing the legacy
   * surface exposes is a discovered/fixed catalog. The `getDefault`
   * path overrides this with `"backend-default"`.
   */
  defaultModelSource?: ModelSource;
}

/**
 * Convert a legacy backend into a `Backend`. The returned object
 * fills only the slots the legacy backend implements — every
 * `Backend` capability is independently `?:`.
 */
export function adaptQueryBackend(
  legacy: QueryBackend,
  id: BackendId,
  label: string,
  options: AdapterOptions = {},
): Backend {
  if (!isBackendId(id)) {
    throw new Error(
      `adaptQueryBackend: ${JSON.stringify(id)} is not a known BackendId. ` +
        `Known ids: ${BACKEND_IDS.join(", ")}.`,
    );
  }

  const chat: ChatBackend = {
    runChatTurn(params) {
      return adaptChatRun(legacy, params);
    },
  };

  const background: BackgroundRunner | undefined = legacy.runOneShotAgent
    ? {
        runBackgroundTask(params) {
          return adaptBackgroundRun(legacy, params, options.logSink);
        },
      }
    : undefined;

  const cache = mapCacheSupport(legacy.cacheMetrics);
  const sourceTag = options.defaultModelSource ?? "discovered";

  const models: ModelCatalog | undefined = legacy.resolveModel
    ? {
        async resolveModel(query, context) {
          const resolution = await legacy.resolveModel!(query);
          return mapResolution(resolution, id, cache, sourceTag, context);
        },
        async listModels(filter) {
          return mapListModels(legacy, filter, id, cache, sourceTag);
        },
        async getDefaultModel(context) {
          return mapDefaultModel(legacy, id, cache, context);
        },
      }
    : undefined;

  const sessions: SessionBackend | undefined =
    legacy.resetChat || legacy.warmSession
      ? {
          resetChat(chatId) {
            return legacy.resetChat?.(chatId);
          },
          warmSession: legacy.warmSession
            ? (chatId) => legacy.warmSession!(chatId)
            : undefined,
        }
      : undefined;

  const tools: ToolRuntime | undefined = legacy.refreshMcpServers
    ? {
        async refreshTools(chatId): Promise<ToolRefreshResult | null> {
          return legacy.refreshMcpServers!(chatId);
        },
      }
    : undefined;

  const usage: UsageTelemetry | undefined = legacy.getSessionSnapshot
    ? {
        async getSessionSnapshot(
          sessionId,
        ): Promise<UsageSnapshot | undefined> {
          const snapshot = await legacy.getSessionSnapshot!(sessionId);
          if (!snapshot) return undefined;
          return {
            inputTokens: snapshot.inputTokens ?? 0,
            outputTokens: snapshot.outputTokens ?? 0,
            cacheRead: snapshot.cacheRead ?? 0,
            cacheWrite: snapshot.cacheWrite ?? 0,
            modelId: snapshot.contextModelId,
          };
        },
      }
    : undefined;

  const partial = { chat, background, models, sessions, tools, usage };

  return {
    id,
    label,
    capabilities: deriveCapabilities(partial),
    ...partial,
  };
}

// ── Chat shim ───────────────────────────────────────────────────────────────

async function* adaptChatRun(
  legacy: QueryBackend,
  params: ChatRunParams,
): AsyncIterable<AgentEvent> {
  yield { type: "run_started" };

  const legacyParams: QueryParams = {
    chatId: params.chatId,
    model: params.model.id,
    text: params.text,
    senderName: params.senderName,
    isGroup: params.isGroup,
    messageId: params.messageId,
  };

  let result: QueryResult;
  try {
    result = await legacy.query(legacyParams);
  } catch (err) {
    yield { type: "error", error: classifyError(err) };
    return;
  }

  if (result.text.length > 0) {
    yield { type: "assistant_message", text: result.text };
  }

  const usage: UsageSnapshot = {
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheRead: result.cacheRead,
    cacheWrite: result.cacheWrite,
    modelId: params.model.id,
  };
  yield { type: "usage", usage };

  const completed: AgentResult = {
    text: result.text,
    durationMs: result.durationMs,
    usage,
    modelId: params.model.id,
  };
  yield { type: "completed", result: completed };
}

// ── Background shim ─────────────────────────────────────────────────────────

async function* adaptBackgroundRun(
  legacy: QueryBackend,
  params: BackgroundRunParams,
  logSink: AdapterOptions["logSink"],
): AsyncIterable<AgentEvent> {
  if (!legacy.runOneShotAgent) {
    yield {
      type: "error",
      error: {
        kind: "unknown",
        message:
          "Legacy backend does not implement runOneShotAgent — adapter " +
          "cannot run a background task.",
        retryable: false,
      },
    };
    return;
  }

  yield { type: "run_started" };

  const legacyParams: OneShotAgentParams = {
    prompt: params.prompt,
    systemPrompt: params.systemPrompt,
    workspace: params.workspace,
    model: params.model.id,
    contextLabel: params.contextLabel,
    abortController: params.abortController,
    appendLog: async (text) => {
      if (logSink) await logSink(text);
    },
  };

  const startedAt = Date.now();
  try {
    await legacy.runOneShotAgent(legacyParams);
  } catch (err) {
    yield { type: "error", error: classifyError(err) };
    return;
  }

  const durationMs = Date.now() - startedAt;
  // Legacy one-shot does not surface assistant text or usage. The
  // adapter still emits a `completed` event with empty text so
  // downstream consumers can rely on the terminator contract.
  yield {
    type: "completed",
    result: {
      text: "",
      durationMs,
      usage: emptyUsage(),
      modelId: params.model.id,
    },
  };
}

// ── Catalog shims ───────────────────────────────────────────────────────────

function unifiedToModelRef(
  info: UnifiedModelInfo,
  backend: BackendId,
  cache: CacheSupport,
  source: ModelSource,
): ModelRef {
  return {
    backend,
    id: info.id,
    displayName: info.displayName ?? info.id,
    provider: info.provider,
    source,
    contextWindow: info.contextWindow,
    effortLevels: info.supportedReasoningLevels,
    defaultEffort: info.defaultReasoningLevel,
    cacheSupport: cache,
    selectable: info.selectable,
    free: info.free,
    unavailableReason: info.unavailableReason,
  };
}

function mapResolution(
  resolution: UnifiedModelResolution,
  backend: BackendId,
  cache: CacheSupport,
  source: ModelSource,
  _context: ModelResolveContext,
): ModelResolution {
  switch (resolution.kind) {
    case "exact":
      return {
        kind: "exact",
        model: unifiedToModelRef(resolution.model, backend, cache, source),
        storedValue: resolution.storedValue,
      };
    case "ambiguous":
      return {
        kind: "ambiguous",
        matches: resolution.matches.map((m) =>
          unifiedToModelRef(m, backend, cache, source),
        ),
      };
    case "missing":
      return { kind: "missing" };
  }
}

async function mapListModels(
  legacy: QueryBackend,
  filter: ModelFilter,
  backend: BackendId,
  cache: CacheSupport,
  source: ModelSource,
): Promise<ModelList> {
  if (!legacy.listModels) {
    return { models: [], total: 0 };
  }
  const filterKey = filter.freeOnly ? "free" : "all";
  const { models, total } = await legacy.listModels(filterKey);
  let mapped = models.map((m) => unifiedToModelRef(m, backend, cache, source));
  if (filter.selectableOnly) {
    mapped = mapped.filter((m) => m.selectable);
  }
  if (filter.query) {
    const needle = filter.query.toLowerCase();
    mapped = mapped.filter(
      (m) =>
        m.id.toLowerCase().includes(needle) ||
        m.displayName.toLowerCase().includes(needle),
    );
  }
  return { models: mapped, total };
}

async function mapDefaultModel(
  legacy: QueryBackend,
  backend: BackendId,
  cache: CacheSupport,
  _context: ModelResolveContext,
): Promise<ModelRef | null> {
  if (!legacy.getDefaultModel) return null;
  const raw = await legacy.getDefaultModel();
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Use getModelInfo when available to fill metadata; otherwise return
  // a bare ref tagged as backend-default.
  if (legacy.getModelInfo) {
    try {
      const info = await legacy.getModelInfo(raw);
      if (info) {
        return unifiedToModelRef(info, backend, cache, "backend-default");
      }
    } catch {
      // Fall through to bare ref.
    }
  }
  const bare = makeBareModelRef(backend, raw, "backend-default");
  return { ...bare, cacheSupport: cache };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapCacheSupport(
  legacy: CacheMetricsSupport | undefined,
): CacheSupport {
  switch (legacy) {
    case "read":
      return "read";
    case "readwrite":
      return "readwrite";
    case "none":
    case undefined:
      return "none";
  }
}

/**
 * Best-effort classification of a thrown error. The richer
 * `core/errors.ts` classifier lives outside this module and Phase 3
 * native backends will use it directly. The adapter only needs a
 * stable enough shape to produce a useful `error` event.
 */
function classifyError(err: unknown): AgentError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  let kind: AgentErrorKind = "unknown";
  let retryable = false;
  if (lower.includes("aborted") || lower.includes("abortcontroller")) {
    kind = "aborted";
  } else if (lower.includes("context") && lower.includes("length")) {
    kind = "context_overflow";
  } else if (lower.includes("rate limit") || lower.includes("rate-limit")) {
    kind = "rate_limit";
    retryable = true;
  } else if (lower.includes("overload") || lower.includes("529")) {
    kind = "overload";
    retryable = true;
  } else if (
    lower.includes("session_expired") ||
    lower.includes("session expired")
  ) {
    kind = "session_expired";
  } else if (lower.includes("timed out") || lower.includes("timeout")) {
    kind = "timeout";
    retryable = true;
  } else if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("auth")
  ) {
    kind = "auth";
  }
  return {
    kind,
    message,
    retryable,
    raw: err instanceof Error ? err.stack : undefined,
  };
}
