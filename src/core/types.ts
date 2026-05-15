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

/** Backend interface — any AI provider implements this. */
export interface QueryBackend {
  query(params: QueryParams): Promise<QueryResult>;
  /** Pre-warm a session (cold-start optimization). Optional — not all backends support this. */
  warmSession?(chatId: string): Promise<void>;
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
  /** Get info for a model by its stored ID. */
  getModelInfo?(id: string): Promise<UnifiedModelInfo | undefined>;
  /** Get quick-pick buttons for model selection. callbackPrefix defaults to "settings:model:". */
  getSettingsPresentation?(
    activeModel: string,
    callbackPrefix?: string,
  ): Promise<{
    modelButtons: ModelButton[];
    modelDetails: string[];
  }>;
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
