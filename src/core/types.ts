/**
 * Core interfaces — the contract between modules.
 * Every module depends on these abstractions, never on concrete implementations.
 *
 * Dependency rule: core/ imports nothing from frontend/ or backend/.
 * frontend/ and backend/ depend on core/types, never on each other.
 */

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
  /**
   * Reasoning/effort levels this model accepts. Omitted or empty means
   * the backend has not registered a valid effort surface for this model.
   */
  supportedReasoningLevels?: ReasoningEffortLevel[];
  /** Backend-reported default reasoning level, when available. */
  defaultReasoningLevel?: ReasoningEffortLevel;
  /** Why the model can't be selected (login required, env setup, etc.) */
  unavailableReason?: string;
};

export type ReasoningEffortLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max"
  | "xhigh";

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
export type ExecuteResult = {
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
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
