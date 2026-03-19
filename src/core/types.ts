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
  messageId?: number;
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
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

/** Backend interface — any AI provider implements this. */
export interface QueryBackend {
  query(params: QueryParams): Promise<QueryResult>;
}

// ── Execution context ───────────────────────────────────────────────────────

/**
 * Manages the tool-execution context for the active chat.
 * The frontend provides an implementation so the AI's tool calls
 * can reach the messaging platform.
 */
export interface ContextManager {
  acquire(chatId: string): void;
  release(chatId: string): void;
  isBusy(): boolean;
  getMessageCount(): number;
}

/** Parameters for the dispatcher. */
export type ExecuteParams = {
  chatId: string;
  prompt: string;
  senderName: string;
  isGroup: boolean;
  messageId?: number;
  source: "message" | "pulse" | "cron";
  onStreamDelta?: (accumulated: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
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
  message_id?: number | string;
  [key: string]: unknown;
};

/** Frontend-specific action handler. Return null if action not recognized. */
export type FrontendActionHandler = (
  body: Record<string, unknown>,
  chatId: string,
) => Promise<ActionResult | null>;
