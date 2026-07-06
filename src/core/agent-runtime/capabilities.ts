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
 * `backend.models?.resolveModelInfo(...)`. Capability presence IS the
 * slot: an absent (`undefined`) slot means the backend doesn't
 * support that capability. There is no separate flag record to keep
 * in sync — the slots are the single source of truth.
 */

import type { AgentEvent } from "./events.js";
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
 * Provenance trust level of a retrieved memory item, per the memory-poisoning
 * threat model (#373). Only the first three levels are ever eligible for
 * automatic injection; `user_claim` and `group_chat` content must stay
 * pull-only (explicit search), never auto-injected.
 */
export type RetrievedMemoryTrustLevel =
  | "dylan_direct" // stated by the operator in a verified DM
  | "bot_inferred" // inferred by the bot from code/docs/verified primary source
  | "heartbeat_synthesis" // synthesized in a background run, no external input
  | "user_claim" // claimed by a non-operator user, unverified
  | "group_chat"; // sourced from group chat content

/** One retrieved memory fragment with its provenance. */
export interface RetrievedMemoryItem {
  /** Palace wing (top-level category), e.g. "technical". */
  wing: string;
  /** Palace room within the wing, when known. */
  room?: string;
  /** Source file locator, when known (e.g. "memory-phase-b.md"). */
  sourceFile?: string;
  /** The retrieved text fragment. */
  text: string;
  /** Retrieval relevance score, when the retriever provides one. */
  score?: number;
  /** Provenance trust level; absent means unknown (treat as untrusted). */
  trustLevel?: RetrievedMemoryTrustLevel;
}

/**
 * A bounded, sanitized slice of long-term memory retrieved for one turn.
 * This is DYNAMIC turn context: it is injected into the live user prompt by
 * the backend prompt formatter and must never enter `prepareSystemPrompt()`
 * output, frozen prompt snapshots, plugin prompt additions, or backend
 * `system` fields — that would break the prompt-cache contract.
 */
export interface RetrievedMemory {
  source: "mempalace";
  /** The (possibly trimmed) query the retriever ran. */
  query: string;
  items: RetrievedMemoryItem[];
}

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
  /**
   * Optional pre-retrieved memory slice for this turn. Backends fold it into
   * the live user prompt (after the cached system prompt), never into
   * `system` — see `formatPromptWithRetrievedMemory`.
   */
  retrievedMemory?: RetrievedMemory;
}

// ── Catalog types ───────────────────────────────────────────────────────────

// ── Capability interfaces ───────────────────────────────────────────────────

/**
 * The chat-turn surface. `runChatTurn` returns an
 * `AsyncIterable<AgentEvent>` carrying per-token deltas, tool
 * events, usage, and the terminator. Consumers iterate the stream
 * directly — the dispatcher forwards each event to the frontend's
 * `onEvent` sink, and frontends switch on `event.type` to drive
 * their delivery UX.
 */
export interface ChatBackend {
  runChatTurn(params: ChatRunParams): AsyncIterable<AgentEvent>;
  /**
   * Best-effort interrupt of the chat's in-flight turn, if one is running.
   * Optional: backends that can't gracefully stop a running turn simply omit
   * it (the frontend then hides the stop affordance). Resolves `true` when a
   * running turn was found and signalled, `false` otherwise. Implementations
   * must stop the turn *cleanly* — the stream should terminate as a normal
   * completion, not surface as an error or trigger a model-fallback retry.
   */
  interruptChatTurn?(chatId: string): Promise<boolean>;
}

/**
 * The background-task surface. Heartbeat / dream / trigger wake-ups
 * invoke this. Same event protocol as `ChatBackend`.
 *
 *   - `runOneShotAgent(params)` — accepts `OneShotAgentParams`
 *     (with its `appendLog` callback) so the heartbeat / dream /
 *     trigger log-file producers keep their direct write path.
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
 * Catalog operations, split into a small REQUIRED core (resolution:
 * `resolveModelInfo` / `getDefaultModelId` / `getRawModelInfo`, which
 * the dispatcher and `core/models/active-model.ts` depend on) and an OPTIONAL
 * picker / catalog-browse surface. A fixed-model backend (Claude SDK
 * on a model alias) can implement only the core and let the `/model`
 * picker degrade gracefully; catalog-driven backends (Kilo, OpenCode,
 * OpenAI Agents on OpenRouter) implement the full surface.
 *
 * The catalog speaks `UnifiedModelInfo` — the rich shape every
 * backend's `models.ts` produces internally. `ModelRef` is only
 * the resolver's output, an enriched routing identity.
 * `core/models/active-model.ts` wraps catalog calls into refs for
 * `/status` and `/model` display.
 */
export interface ModelCatalog {
  // ── Required core: resolution ───────────────────────────────────
  /**
   * Backend-native resolve. Used by `core/models/active-model.ts` for the
   * per-chat override validation and by the frontend's
   * resolution-error formatter.
   */
  resolveModelInfo(query: string): Promise<UnifiedModelResolution>;
  /**
   * Canonical default returning the raw model id (or `null` /
   * `undefined` for catalog-driven backends with no canonical).
   */
  getDefaultModelId():
    Promise<string | null | undefined> | string | null | undefined;
  /** Backend-native model lookup by id. */
  getRawModelInfo(id: string): Promise<UnifiedModelInfo | undefined>;

  // ── Optional picker / catalog-browse surface ────────────────────
  // A fixed-model backend (no real catalog) omits these; the `/model`
  // and `/settings` frontends degrade gracefully — no quick-pick, no
  // provider browse — when a method is absent.
  /** Quick-pick presentation for `/model` and `/settings`. */
  getSettingsPresentation?(
    activeModel: string,
    options?: ModelPickerOptions,
  ): Promise<ModelPickerResult>;
  /** List of providers exposed by the backend's catalog. */
  getProviders?(): Promise<UnifiedProviderInfo[]>;
  /** Paginated model list scoped to one provider. */
  getProviderModels?(
    providerId: string,
    page?: number,
    pageSize?: number,
  ): Promise<{ models: UnifiedModelInfo[]; total: number }>;
  /** Format an error for an unresolvable / unavailable model. */
  formatModelError?(query: string, resolution: UnifiedModelResolution): string;
  /** Free-tier-or-all model list. */
  listModels?(filter?: "free" | "all"): Promise<{
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
  chat?: ChatBackend;
  background?: BackgroundRunner;
  models?: ModelCatalog;
  sessions?: SessionBackend;
  tools?: ToolRuntime;
  usage?: UsageTelemetry;
  control?: SystemControl;
}

/**
 * Build a `Backend` from its slot components. A slot left out is a
 * capability the backend doesn't support — consumers read presence
 * directly (`backend.chat?.…`). The slot set is the single source of
 * truth for what a backend can do; there's no derived flag record to
 * keep in lockstep.
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
  return {
    id: input.id,
    label: input.label,
    cacheMetrics: input.cacheMetrics ?? "none",
    chat: input.chat,
    background: input.background,
    models: input.models,
    sessions: input.sessions,
    tools: input.tools,
    usage: input.usage,
    control: input.control,
  };
}
