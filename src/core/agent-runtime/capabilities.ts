/**
 * Backend capability interfaces.
 *
 * The current `QueryBackend` is a fat optional interface — every
 * method is `?:`, so callers can't tell at the type level which
 * backends actually implement which capabilities. The fix is to
 * split the interface into smaller orthogonal capabilities and
 * compose them on a `Backend` object that names what it does.
 *
 *   - `ChatBackend.runChatTurn`         — primary turn loop
 *   - `BackgroundRunner.runBackgroundTask` — heartbeat / dream
 *   - `ModelCatalog`                     — resolution + listing
 *   - `SessionBackend`                   — reset + warm
 *   - `ToolRuntime`                      — hot MCP refresh
 *   - `UsageTelemetry`                   — `/status` enrichment
 *
 * Phase 1 only defines the types and a thin adapter
 * (`adapter.ts`) that wraps the existing `QueryBackend` into a
 * `Backend` so callers can begin migrating. The actual streaming
 * implementation lands in Phase 3.
 */

import type { AgentEvent } from "./events.js";
import type { ModelRef, BackendId } from "./model-ref.js";
import type { RunPolicy } from "./run-policy.js";

// ── Run parameters ──────────────────────────────────────────────────────────

/**
 * Parameters for a chat turn. Mirrors the legacy `QueryParams`
 * shape with two additions:
 *
 *   - `model` is a resolved `ModelRef`, not a naked string.
 *   - `policy` carries the operational contract.
 *
 * Streaming callbacks (`onStreamDelta`, `onTextBlock`,
 * `onToolUse`) are not part of this shape — Phase 3 backends emit
 * events instead. Phase 1 adapter glue (see `adapter.ts`) handles
 * the bridging.
 */
export interface ChatRunParams {
  chatId: string;
  model: ModelRef;
  policy: RunPolicy;
  text: string;
  senderName: string;
  isGroup?: boolean;
  /** Provider message ID. Telegram is numeric; Discord snowflakes are strings. */
  messageId?: number | string;
  /** Aborts the run mid-flight (signal propagates to subprocesses). */
  abortController?: AbortController;
}

/**
 * Parameters for a one-shot background task (heartbeat / dream /
 * trigger wake-up). Mirrors legacy `OneShotAgentParams` with the
 * structural-policy additions.
 */
export interface BackgroundRunParams {
  prompt: string;
  systemPrompt: string;
  workspace: string;
  model: ModelRef;
  policy: RunPolicy;
  /** Sentinel for the bridge's chat-id routing (`"heartbeat"`, etc). */
  contextLabel: string;
  abortController: AbortController;
}

// ── Catalog types ───────────────────────────────────────────────────────────

/**
 * Context for catalog resolution. The resolver may need to know
 * which chat is asking (chat-pinned overrides), which auth mode is
 * active (Codex API key vs ChatGPT OAuth), and whether free-tier
 * filtering is on.
 */
export interface ModelResolveContext {
  chatId?: string;
  filter?: "all" | "free";
}

/**
 * Result of one resolve query — same shape as the existing
 * `UnifiedModelResolution`, expressed in terms of `ModelRef`.
 */
export type ModelResolution =
  | { kind: "exact"; model: ModelRef; storedValue: string }
  | { kind: "ambiguous"; matches: ModelRef[] }
  | { kind: "missing" };

/**
 * Filter for catalog listing.
 */
export interface ModelFilter {
  /** Show only free-tier models. */
  freeOnly?: boolean;
  /** Show only models marked selectable. */
  selectableOnly?: boolean;
  /** Substring match against `id` or `displayName`. Case-insensitive. */
  query?: string;
}

/**
 * Page of models from a backend's catalog. Total is the unpaginated
 * count after filter.
 */
export interface ModelList {
  models: ModelRef[];
  total: number;
}

// ── Capability interfaces ───────────────────────────────────────────────────

/**
 * The chat-turn surface. A backend that supports interactive chat
 * implements this. The returned stream emits `AgentEvent`s and
 * terminates with `completed` or `error`.
 */
export interface ChatBackend {
  runChatTurn(params: ChatRunParams): AsyncIterable<AgentEvent>;
}

/**
 * The background-task surface. Heartbeat, dream, and trigger
 * wake-ups invoke this. Same event protocol as `ChatBackend` — the
 * difference is the `RunPolicy.kind`.
 */
export interface BackgroundRunner {
  runBackgroundTask(params: BackgroundRunParams): AsyncIterable<AgentEvent>;
}

/**
 * Catalog operations. A backend with no catalog (Claude SDK on
 * model alias) returns a single-entry list from `listModels` and
 * a fixed canonical from `getDefaultModel`. Catalog-driven backends
 * (Kilo, OpenCode, OpenAI Agents on OpenRouter) implement the full
 * surface.
 */
export interface ModelCatalog {
  resolveModel(
    query: string,
    context: ModelResolveContext,
  ): Promise<ModelResolution>;
  listModels(filter: ModelFilter): Promise<ModelList>;
  /**
   * Canonical default — may be `null` for catalog-driven backends
   * with no canonical (matches the contract on the legacy
   * `getDefaultModel`).
   */
  getDefaultModel(context: ModelResolveContext): Promise<ModelRef | null>;
}

/**
 * Session lifecycle. Backends with in-process conversation memory
 * implement at least `resetChat`. `warmSession` is a cold-start
 * optimisation hint — backends can no-op.
 */
export interface SessionBackend {
  resetChat(chatId: string): void | Promise<void>;
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
 */
import type { UsageSnapshot } from "./events.js";

export interface UsageTelemetry {
  getSessionSnapshot(sessionId: string): Promise<UsageSnapshot | undefined>;
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
}

/**
 * Composed backend object. Missing capabilities are explicit
 * `undefined` slots, not optional methods on a fat interface.
 */
export interface Backend {
  id: BackendId;
  label: string;
  capabilities: BackendCapabilities;
  chat?: ChatBackend;
  background?: BackgroundRunner;
  models?: ModelCatalog;
  sessions?: SessionBackend;
  tools?: ToolRuntime;
  usage?: UsageTelemetry;
}

/**
 * Derive `BackendCapabilities` from a partially-populated backend
 * object. Helper for adapter code that fills in slots
 * conditionally.
 */
export function deriveCapabilities(
  partial: Omit<Backend, "id" | "label" | "capabilities">,
): BackendCapabilities {
  return {
    chat: Boolean(partial.chat),
    background: Boolean(partial.background),
    models: Boolean(partial.models),
    sessions: Boolean(partial.sessions),
    tools: Boolean(partial.tools),
    usage: Boolean(partial.usage),
  };
}
