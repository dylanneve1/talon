/**
 * Core interfaces — the contract between modules.
 * Every module depends on these abstractions, never on concrete implementations.
 *
 * Dependency rule: core/ imports nothing from frontend/ or backend/.
 * frontend/ and backend/ depend on core/types, never on each other.
 */

// ── Query lifecycle ─────────────────────────────────────────────────────────

/** Parameters for a backend AI query. */
export type QueryParams = {
  chatId: string;
  text: string;
  senderName: string;
  isGroup?: boolean;
  /**
   * Provider message ID. Telegram is numeric; Discord snowflakes are strings.
   */
  messageId?: number | string;
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
};

/** Result of a backend AI query. */
export type QueryResult = {
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

// ── Model abstraction ──────────────────────────────────────────────────────

/** Unified model info returned by any backend. */
export type UnifiedModelInfo = {
  id: string;
  displayName: string;
  provider: string;
  providerName: string;
  selectable: boolean;
  free?: boolean;
  contextWindow?: number;
  reasoning?: boolean;
  /** Why the model can't be selected (login required, env setup, etc.) */
  unavailableReason?: string;
};

/** Result of resolving a user's model query. */
export type UnifiedModelResolution =
  | { kind: "exact"; model: UnifiedModelInfo; storedValue: string }
  | { kind: "ambiguous"; matches: UnifiedModelInfo[] }
  | { kind: "missing" };

/** A provider with its available models. */
export type UnifiedProviderInfo = {
  id: string;
  name: string;
  connected: boolean;
  modelCount: number;
};

/** Keyboard button for model/settings UIs. */
export type ModelButton = { text: string; callback_data: string };

/**
 * Options for `getSettingsPresentation()`. The picker has two
 * navigational axes — *provider* (when a catalog is large enough to
 * benefit from grouping) and *page within a provider*. Backends with
 * small catalogs may ignore everything except `callbackPrefix`.
 */
export interface ModelPickerOptions {
  /** Callback-data prefix used on each model button. Defaults to `settings:model:`. */
  callbackPrefix?: string;
  /**
   * Callback-data prefix used for navigation buttons (provider drill,
   * pagination, filter toggles). Defaults to `settings:models`. Must
   * match the prefix the frontend's callback router decodes — for
   * example `/model` uses `model:nav` so its router recognises
   * `model:nav:provider:openai` as a drill action.
   */
  navCallbackPrefix?: string;
  /** 1-indexed page within the current provider/filter. Defaults to 1. */
  page?: number;
  /** Buttons per page. Backends may clamp to a sensible range. */
  pageSize?: number;
  /** Filter the catalog before grouping/paginating. `free` keeps only free-tier models. */
  filter?: "all" | "free";
  /**
   * When set, render that provider's models directly. When omitted
   * and the filtered catalog is "large" (backend-defined threshold),
   * the backend returns provider chips instead of model buttons —
   * the frontend drills in by sending this option back.
   */
  provider?: string;
}

/**
 * Result returned by `getSettingsPresentation()`. `view` tells the
 * frontend whether `modelButtons` is a list of providers ("groups")
 * or a list of models ("models"). The frontend reads `page` /
 * `totalPages` / `freeCount` / `provider` to render the appropriate
 * navigation controls.
 */
export interface ModelPickerResult {
  /** Buttons to render. Interpretation depends on `view`. Empty for `menu`. */
  modelButtons: ModelButton[];
  /** Optional supplementary text (backend status, etc.). Plain text. */
  modelDetails: string[];
  /**
   * Which axis the buttons represent:
   *   - `groups`: provider chips (drill by tapping).
   *   - `models`: the model list (paginated).
   */
  view: "groups" | "models";
  /** Current 1-indexed page (always 1 for `groups`). */
  page: number;
  /** Total pages in the current view. */
  totalPages: number;
  /** The filter actually applied (normalised). */
  filter: "all" | "free";
  /** Total free-flagged models in the (unfiltered) catalog. */
  freeCount: number;
  /** Total models in the (unfiltered) catalog. */
  totalCount: number;
  /** When `view === "models"`, the provider the buttons belong to (if any). */
  provider?: string;
}

/**
 * Parameters for one-shot agent runs (heartbeat, dream).
 *
 * Unlike `query()` which is tied to a chat session and history, this is a
 * fire-and-forget agent invocation: spawn an agent with a prompt, let it run
 * tools, log everything to a file, return when it finishes (or when aborted).
 */
export type OneShotAgentParams = {
  /** The user prompt the agent should execute. */
  prompt: string;
  /** Additional system prompt prepended to the backend's defaults. */
  systemPrompt: string;
  /** Working directory for the agent (cwd for tool execution). */
  workspace: string;
  /** Model id (interpretation is backend-specific). */
  model: string;
  /**
   * Sentinel chat ID for outbound MCP tool calls (e.g. "heartbeat", "dream").
   * Frontend MCP servers use this to enforce explicit `chat_id` on outbound
   * tools when there's no ambient chat.
   */
  contextLabel: string;
  /** Aborts the agent run mid-flight (signal will be delivered to subprocesses). */
  abortController: AbortController;
  /** Append a string to the run log (markdown). */
  appendLog: (text: string) => Promise<void>;
};

/** How much cache telemetry a backend can surface in /status. */
export type CacheMetricsSupport = "none" | "read" | "readwrite";

/** Backend interface — any AI provider implements this. */
export interface QueryBackend {
  query(params: QueryParams): Promise<QueryResult>;
  /** Pre-warm a session (cold-start optimization). Optional — not all backends support this. */
  warmSession?(chatId: string): Promise<void>;
  /**
   * Drop any in-process conversation memory the backend holds for a
   * chat. Called from `/reset`. Backends that lean on the SDK's own
   * session abstraction (openai-agents `MemorySession`, etc.) need
   * this hook so a reset actually wipes the model's working memory;
   * stateless backends can ignore it.
   */
  resetChat?(chatId: string): void;
  /** Update the system prompt on the live backend config. Optional — used by plugin hot-reload. */
  updateSystemPrompt?(prompt: string): void;
  /** Hot-swap MCP servers on the active query for a chat. Optional — used by plugin hot-reload. */
  refreshMcpServers?(chatId: string): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  } | null>;
  /** Resolve a user's model query to a concrete model. */
  resolveModel?(query: string): Promise<UnifiedModelResolution>;
  /**
   * The canonical default model this backend uses when no per-chat
   * override is set. Consumed by `core/active-model.ts` as step 2 of
   * the resolution chain.
   *
   * Backends with a single canonical default (Claude SDK, Codex,
   * stock OpenAI Agents) should implement this.
   * Codex's default is auth-aware (`gpt-5-codex` on API key,
   * `gpt-5.5` on ChatGPT OAuth — the latter rejects the former).
   *
   * **Catalog-driven backends without a canonical default** (Kilo,
   * OpenCode, OpenAI Agents pointed at OpenRouter / custom OpenAI-
   * compatible endpoints) should either omit this method entirely OR
   * return `null` / `undefined` / `""` — the resolver treats all three
   * as "no canonical default, fall through to `backendDefaults[id]`".
   *
   * The conditional-return pattern is useful for backends that have a
   * default in one configuration but not another (OpenAI Agents:
   * canonical only on stock OpenAI; null on OpenRouter / custom).
   *
   * May be async: Codex peeks at live auth mode; other backends may
   * read a cache file or stable constant synchronously.
   */
  getDefaultModel?():
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;
  /** Get info for a model by its stored ID. */
  getModelInfo?(id: string): Promise<UnifiedModelInfo | undefined>;
  /**
   * Get the quick-pick model picker for /settings. Backends with
   * large catalogs (e.g. OpenRouter via openai-agents) should honour
   * `options.page` / `options.filter` so the picker is browseable;
   * small-catalog backends may ignore them and always return the
   * full set on page 1. The frontend reads `page` / `totalPages` /
   * `freeCount` off the result to render Prev/Next + filter chips.
   */
  getSettingsPresentation?(
    activeModel: string,
    options?: ModelPickerOptions,
  ): Promise<ModelPickerResult>;
  /** List available providers. */
  getProviders?(): Promise<UnifiedProviderInfo[]>;
  /** List models for a given provider (paginated). */
  getProviderModels?(
    providerId: string,
    page?: number,
    pageSize?: number,
  ): Promise<{ models: UnifiedModelInfo[]; total: number }>;
  /** Format error for an unresolvable/unavailable model. */
  formatModelError?(query: string, resolution: UnifiedModelResolution): string;
  /** Get live session usage snapshot (for /status enrichment). */
  getSessionSnapshot?(sessionId: string): Promise<
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        contextModelId?: string;
      }
    | undefined
  >;
  /**
   * Whether the backend can surface cache telemetry in /status.
   * `none` hides the cache section entirely.
   */
  cacheMetrics?: CacheMetricsSupport;
  /** List models matching a filter. Frontends use this for /model free|all|list. */
  listModels?(filter?: "free" | "all"): Promise<{
    models: UnifiedModelInfo[];
    total: number;
  }>;
  /** Human-readable backend label for UIs (e.g. "Anthropic", "OpenCode"). */
  backendLabel?: string;
  /**
   * Run a one-shot agent task (heartbeat / dream). Optional — backends that
   * don't implement this will cause the heartbeat/dream timer to skip with a
   * warning at startup rather than throw at runtime.
   */
  runOneShotAgent?(params: OneShotAgentParams): Promise<void>;
  /**
   * Evict any orphaned subprocesses spawned by this backend that are tagged
   * with the given context label. Called when `runOneShotAgent` was aborted
   * but its subprocess didn't exit gracefully within the abort grace window.
   * Optional — only relevant for backends that spawn per-query subprocesses
   * (Claude SDK). Backends with a long-running shared server (Kilo, OpenCode)
   * have nothing to evict.
   */
  evictOrphanSubprocesses?(contextLabel: string): Promise<{
    found: number;
    termed: number;
    killed: number;
  }>;
}

// ── Execution context ───────────────────────────────────────────────────────

/**
 * Manages the tool-execution context for the active chat.
 * The frontend provides an implementation so the AI's tool calls
 * can reach the messaging platform.
 */
export interface ContextManager {
  acquire(chatId: number, stringId?: string): void;
  release(chatId: number): void;
  getMessageCount(chatId: number): number;
}

/** Parameters for the dispatcher. */
export type ExecuteParams = {
  chatId: string;
  numericChatId: number;
  prompt: string;
  senderName: string;
  isGroup: boolean;
  /** Provider message ID. Numeric for Telegram, string snowflake for Discord. */
  messageId?: number | string;
  source: "message" | "pulse" | "cron" | "trigger";
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
  onToolUse?: (toolName: string, input: Record<string, unknown>) => void;
};

/** What the dispatcher returns after execution. */
export type ExecuteResult = QueryResult & {
  bridgeMessageCount: number;
};

// ── Gateway types ───────────────────────────────────────────────────────────

/** Result from an action handler. */
export type ActionResult = {
  ok: boolean;
  text?: string;
  error?: string;
  /**
   * Provider message ID. Telegram uses numeric IDs; Discord (and other
   * snowflake-based platforms) emit string IDs. The dispatcher treats it
   * opaquely — it's surfaced back to the LLM as-is for use in subsequent
   * tool calls (react/edit/delete) that target this message.
   */
  message_id?: number | string;
  [key: string]: unknown;
};

/** Frontend-specific action handler. Return null if action not recognized. */
export type FrontendActionHandler = (
  body: Record<string, unknown>,
  chatId: number,
) => Promise<ActionResult | null>;
