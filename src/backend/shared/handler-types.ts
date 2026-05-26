/**
 * Backend-internal handler types.
 *
 * `QueryParams` and `QueryResult` describe the callback-shaped contract
 * each backend's `handler.ts` exposes internally. They are NOT core
 * abstractions — `ChatBackend.runChatTurn` (in
 * `core/agent-runtime/capabilities.ts`) is the canonical surface every
 * consumer outside `src/backend/` talks to. These types exist only
 * because the per-backend handlers keep an internal callback-driven
 * stream loop that `handler-to-events.ts` adapts onto the native
 * `AsyncIterable<AgentEvent>` shape at the factory boundary.
 *
 * Living in `backend/shared/` keeps `core/types.ts` clean of any
 * implementation-detail shapes, so the dispatcher / cron / triggers /
 * frontends never accidentally couple to the callback contract.
 */

// ── Query lifecycle (backend-internal) ──────────────────────────────────────

/** Parameters for a backend AI query. */
export type QueryParams = {
  chatId: string;
  /**
   * Model id resolved by the dispatcher for this chat/backend. Backends should
   * use this instead of re-reading chat settings so UI state, send-time guards,
   * and actual runtime model stay in lockstep.
   */
  model?: string;
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
