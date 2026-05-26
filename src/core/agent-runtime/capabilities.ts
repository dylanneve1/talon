/**
 * Backend capability interfaces.
 *
 * Every backend factory builds and returns a `Backend` — a composed
 * object whose capability slots cover the orthogonal pieces a
 * production frontend / dispatcher needs:
 *
 *   - `chat`        — chat-turn surface (`runChatTurn`)
 *   - `background`  — heartbeat / dream / trigger background tasks
 *   - `models`      — catalog (resolve / list / picker / providers)
 *   - `sessions`    — reset / warm
 *   - `tools`       — hot MCP refresh
 *   - `usage`       — `/status` enrichment
 *   - `control`     — system-prompt update
 *
 * Consumers read through slots — `backend.chat?.runChatTurn(...)`,
 * `backend.models?.resolveModel(...)`. Capability presence is
 * declared at the type level via the optional slot fields and
 * mirrored on `backend.capabilities` for runtime introspection.
 */

import type { AgentEvent, UsageSnapshot } from "./events.js";
import type { ModelRef, BackendId } from "./model-ref.js";
import type {
  CacheMetricsSupport,
  ModelPickerOptions,
  ModelPickerResult,
  OneShotAgentParams,
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
} from "../types.js";

// ── Run parameters ──────────────────────────────────────────────────────────

/**
 * Parameters for a chat turn. `model` is a resolved `ModelRef`,
 * carrying everything the backend needs to identify the model and
 * render the resulting reply. Streaming callbacks aren't part of
 * this shape — backends emit `AgentEvent`s.
 */
export interface ChatRunParams {
  chatId: string;
  model: ModelRef;
  text: string;
  senderName: string;
  isGroup?: boolean;
  /** Provider message ID. Telegram is numeric; Discord snowflakes are strings. */
  messageId?: number | string;
  /** Aborts the run mid-flight (signal propagates to subprocesses). */
  abortController?: AbortController;
}

// ── Catalog types ───────────────────────────────────────────────────────────

// ── Capability interfaces ───────────────────────────────────────────────────

/**
 * The chat-turn surface. `runChatTurn` returns an
 * `AsyncIterable<AgentEvent>` carrying per-token deltas, tool
 * events, usage, and the terminator. Consumers that need a
 * `QueryResult`-shaped accumulation use `reduceEventsToResult`
 * from `legacy-bridge.ts`; consumers that need callback-driven
 * delivery use `pipeEventsToCallbacks`.
 */
export interface ChatBackend {
  runChatTurn(params: ChatRunParams): AsyncIterable<AgentEvent>;
}

/**
 * The background-task surface. Heartbeat / dream / trigger wake-ups
 * invoke this. Same event protocol as `ChatBackend`.
 *
 *   - `runOneShotAgent(params)` — accepts the legacy
 *     `OneShotAgentParams` (with its `appendLog` callback) so the
 *     existing heartbeat / dream log-file producers keep their
 *     direct write path. Consumers that want to consume the stream
 *     directly (via `streamLog`) compose with
 *     `backend/shared/to-event-stream.ts:toOneShotEventStream`
 *     externally.
 *   - `evictOrphanSubprocesses(label)` — backends that spawn
 *     per-run subprocesses (Claude SDK) implement this so a hung
 *     run can be force-cleaned after the abort grace window.
 */
export interface BackgroundRunner {
  runOneShotAgent(params: OneShotAgentParams): Promise<void>;
  evictOrphanSubprocesses?(contextLabel: string): Promise<{
    found: number;
    termed: number;
    killed: number;
  }>;
}

/**
 * Catalog operations. A backend with no catalog (Claude SDK on a
 * model alias) returns a single-entry list and a fixed canonical
 * from `getDefaultModelId`. Catalog-driven backends (Kilo,
 * OpenCode, OpenAI Agents on OpenRouter) implement the full
 * surface.
 *
 * The catalog speaks `UnifiedModelInfo` — the rich shape every
 * backend's `models.ts` produces internally. `ModelRef` is only
 * the resolver's output, an enriched routing identity. The
 * resolver (`agent-runtime/resolver.ts`) wraps catalog calls into
 * refs for `/status` and `/model` display.
 */
export interface ModelCatalog {
  /**
   * Backend-native resolve. Used by `core/active-model.ts` for the
   * per-chat override validation and by the frontend's
   * resolution-error formatter.
   */
  resolveModelInfo(query: string): Promise<UnifiedModelResolution>;
  /**
   * Canonical default returning the raw model id (or `null` /
   * `undefined` for catalog-driven backends with no canonical).
   */
  getDefaultModelId():
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;
  /** Backend-native model lookup by id. */
  getRawModelInfo(id: string): Promise<UnifiedModelInfo | undefined>;
  /** Quick-pick presentation for `/model` and `/settings`. */
  getSettingsPresentation(
    activeModel: string,
    options?: ModelPickerOptions,
  ): Promise<ModelPickerResult>;
  /** List of providers exposed by the backend's catalog. */
  getProviders(): Promise<UnifiedProviderInfo[]>;
  /** Paginated model list scoped to one provider. */
  getProviderModels(
    providerId: string,
    page?: number,
    pageSize?: number,
  ): Promise<{ models: UnifiedModelInfo[]; total: number }>;
  /** Format an error for an unresolvable / unavailable model. */
  formatModelError(query: string, resolution: UnifiedModelResolution): string;
  /** Free-tier-or-all model list. */
  listModels(filter?: "free" | "all"): Promise<{
    models: UnifiedModelInfo[];
    total: number;
  }>;
}

/**
 * Session lifecycle. Both methods optional:
 *
 *   - `resetChat` — drop any in-process conversation memory the
 *     backend holds for a chat. Required only for backends that
 *     keep their own session abstraction in memory (OpenAI Agents
 *     `MemorySession`); stateless backends omit it.
 *   - `warmSession` — cold-start optimisation hint.
 *
 * The dispatcher / `/reset` flow always also calls
 * `storage/sessions.ts:resetSession(chatId)` so the chat's stored
 * session id is cleared regardless of which slot variant the backend
 * provides.
 */
export interface SessionBackend {
  resetChat?(chatId: string): void | Promise<void>;
  warmSession?(chatId: string): Promise<void>;
}

/**
 * Hot-reloadable tool surface. Used when a plugin is added or
 * removed at runtime — the backend re-derives its MCP config from
 * the live registry. Returns the diff so the dispatcher can log
 * what changed.
 */
export interface ToolRefreshResult {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
}

export interface ToolRuntime {
  refreshTools(chatId: string): Promise<ToolRefreshResult | null>;
}

/**
 * `/status` enrichment. Backends that track per-session usage
 * (Codex, OpenAI Agents) implement this. Backends without a
 * per-session model (Claude SDK on a fresh subprocess per turn)
 * return `undefined`.
 *
 * The snapshot's `contextModelId` carries the resolved-this-turn
 * model id when the SDK can surface it. Frontend `/status` reads
 * it to disambiguate the displayed model from the configured one
 * (e.g. when Codex falls back from `gpt-5-codex` to `gpt-5.5` on
 * ChatGPT-OAuth).
 */
export interface UsageTelemetry {
  getSessionSnapshot(sessionId: string): Promise<
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        contextModelId?: string;
      }
    | undefined
  >;
}

/**
 * Process-level control surface. Plugin hot-reload pokes the
 * system prompt through here; nothing else mutates backend state
 * out-of-band of `runChatTurn`.
 */
export interface SystemControl {
  /** Update the system prompt on the live backend config. */
  updateSystemPrompt(prompt: string): void;
}

// ── Composed backend ────────────────────────────────────────────────────────

/**
 * Capability flags — runtime introspection for callers that want
 * to know what a backend supports before calling.
 */
export interface BackendCapabilities {
  chat: boolean;
  background: boolean;
  models: boolean;
  sessions: boolean;
  tools: boolean;
  usage: boolean;
  control: boolean;
}

/**
 * Composed backend object. Missing capabilities are explicit
 * `undefined` slots, not optional methods on a fat interface.
 *
 * `cacheMetrics` lives at the top because every consumer reads it
 * (status, dispatcher logging, telemetry); pushing it under
 * `usage` would force `/status` to traverse a slot for one piece
 * of metadata.
 */
export interface Backend {
  id: BackendId;
  label: string;
  cacheMetrics: CacheMetricsSupport;
  capabilities: BackendCapabilities;
  chat?: ChatBackend;
  background?: BackgroundRunner;
  models?: ModelCatalog;
  sessions?: SessionBackend;
  tools?: ToolRuntime;
  usage?: UsageTelemetry;
  control?: SystemControl;
}

/**
 * Derive `BackendCapabilities` from a partially-populated backend
 * object. Helper for factory code that fills in slots conditionally.
 */
export function deriveCapabilities(
  partial: Omit<Backend, "id" | "label" | "cacheMetrics" | "capabilities">,
): BackendCapabilities {
  return {
    chat: Boolean(partial.chat),
    background: Boolean(partial.background),
    models: Boolean(partial.models),
    sessions: Boolean(partial.sessions),
    tools: Boolean(partial.tools),
    usage: Boolean(partial.usage),
    control: Boolean(partial.control),
  };
}

/**
 * Build a fully-populated `Backend` from its slot components.
 * Wires `capabilities` automatically from which slots were
 * provided. Factories use this to avoid hand-rolling the capability
 * flag set on every call site.
 */
export function composeBackend(input: {
  id: BackendId;
  label: string;
  cacheMetrics?: CacheMetricsSupport;
  chat?: ChatBackend;
  background?: BackgroundRunner;
  models?: ModelCatalog;
  sessions?: SessionBackend;
  tools?: ToolRuntime;
  usage?: UsageTelemetry;
  control?: SystemControl;
}): Backend {
  const partial = {
    chat: input.chat,
    background: input.background,
    models: input.models,
    sessions: input.sessions,
    tools: input.tools,
    usage: input.usage,
    control: input.control,
  };
  return {
    id: input.id,
    label: input.label,
    cacheMetrics: input.cacheMetrics ?? "none",
    capabilities: deriveCapabilities(partial),
    ...partial,
  };
}
