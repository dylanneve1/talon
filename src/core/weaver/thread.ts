/**
 * Thread — the single owner of one chat's live state, held by the Loom.
 *
 * Everything that is "live" about a chat lives here, so reasoning about
 * "what is the state of chat X" means looking at one object:
 *
 *   - serialization chain — per-chat FIFO ordering of turns (warp/weft), so
 *     two messages in the same chat never race the same backend session while
 *     different chats still run in true parallel;
 *   - execution context — a refcount + per-turn message counter that bracket
 *     each in-flight turn (absorbed from the gateway's old `ChatContext`).
 *
 * A Thread is created lazily by the Loom on first reference. It is `busy`
 * while it has either a queued/running turn or a held context, and is safe to
 * evict only when fully idle.
 */

import { ThreadSession, type SessionSummary } from "./thread-session.js";

/**
 * The warp — the durable per-turn binding the Shuttle carries the weft
 * across. Recorded when a turn resolves its model so configured-vs-running
 * divergence is explicit state a snapshot can surface, not a silent fallback.
 */
export type Warp = {
  /** Model id actually bound for the last turn (after any per-run override). */
  model: string;
  /** Backend id serving the chat. */
  backendId: string;
  /** A per-run model override (trigger/cron) was applied for this turn. */
  overridden: boolean;
  /** When the warp was last bound (ms since epoch). */
  boundAt: number;
};

/** Immutable view of a Thread's live state, for `weaver.snapshot()`. */
export type ThreadSnapshot = {
  chatId: string;
  numericChatId?: number;
  /** Turns queued or running on this Thread. */
  inFlightCount: number;
  /** Whether a turn is currently holding the execution context. */
  contextActive: boolean;
  /** Bridge messages sent during the current turn. */
  messagesSent: number;
  /** The model/backend bound for the last turn, if one has run. */
  warp?: Warp;
  /** Compact view of the chat's persisted session. */
  session: SessionSummary;
};

export class Thread {
  readonly chatId: string;

  // ── Serialization (per-chat FIFO) ──────────────────────────────────────────
  private chain: Promise<unknown> | undefined;
  private queuedCount = 0;

  // ── Execution context (per-turn; absorbed from gateway ChatContext) ─────────
  private refCount = 0;
  private messagesSent = 0;
  private numeric: number | undefined;

  // ── Warp (resolved model/backend binding for the last turn) ─────────────────
  private warpState: Warp | undefined;

  // ── Session (handle to storage/sessions.ts, the source of truth) ────────────
  private sessionHandle: ThreadSession | undefined;

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  /**
   * The Thread's handle to its persisted session. Lazily created; the backing
   * store (`storage/sessions.ts`) stays the source of truth.
   */
  get session(): ThreadSession {
    return (this.sessionHandle ??= new ThreadSession(this.chatId));
  }

  // ── Serialization ───────────────────────────────────────────────────────────

  /** Turns queued or running on this Thread's chain. */
  get inFlightCount(): number {
    return this.queuedCount;
  }

  /**
   * True while the Thread is doing anything — a queued/running turn OR a held
   * execution context. The Loom evicts only when this is false.
   */
  get busy(): boolean {
    return this.queuedCount > 0 || this.refCount > 0;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.chain ?? Promise.resolve();
    this.queuedCount++;

    // Use .catch(() => {}) on prev to prevent unhandled rejections —
    // previous query's error is already handled by its own caller.
    const queued = prev.catch(() => {}).then(fn);
    this.chain = queued; // must happen before any await

    // Clean up chain entry when this is the last in the chain.
    queued
      .catch(() => {})
      .finally(() => {
        this.queuedCount--;
        if (this.chain === queued) this.chain = undefined;
      });

    return queued;
  }

  // ── Execution context ─────────────────────────────────────────────────────────

  /** The numeric chat id bound by the last context acquisition, if any. */
  get numericChatId(): number | undefined {
    return this.numeric;
  }

  /** True while a turn is holding this Thread's execution context. */
  get contextActive(): boolean {
    return this.refCount > 0;
  }

  /** Messages the bridge has sent during the current turn (resets per turn). */
  get messageCount(): number {
    return this.messagesSent;
  }

  /**
   * Acquire the execution context for a turn. The first acquisition
   * (refCount 0→1) starts a fresh context: the per-turn message counter
   * resets to 0 and the numeric id is (re)bound. This matches the gateway's
   * old create-on-demand `ChatContext`, so `messageCount` (the dispatcher's
   * `bridgeMessageCount`) is always scoped to the current turn. Re-entrant
   * acquisitions only bump the refcount.
   */
  acquireContext(numericChatId: number): void {
    if (this.refCount === 0) {
      this.messagesSent = 0;
      this.numeric = numericChatId;
    }
    this.refCount++;
  }

  /** Release one context hold. The context is cleared when it reaches zero. */
  releaseContext(): void {
    if (this.refCount > 0) this.refCount--;
  }

  /** Count one outbound message sent by the bridge during the current turn. */
  noteMessageSent(): void {
    this.messagesSent++;
  }

  // ── Warp ────────────────────────────────────────────────────────────────────

  /** The model/backend bound for the last turn, if one has run. */
  get warp(): Warp | undefined {
    return this.warpState;
  }

  /**
   * Record the warp resolved for a turn. Returns whether the model or backend
   * changed since the last turn (drift) along with the previous warp, so the
   * Weaver can surface a configured-vs-running divergence instead of letting
   * it pass silently.
   */
  bindWarp(warp: Warp): { drifted: boolean; previous?: Warp } {
    const previous = this.warpState;
    const drifted =
      previous !== undefined &&
      (previous.model !== warp.model || previous.backendId !== warp.backendId);
    this.warpState = warp;
    return { drifted, previous };
  }

  // ── Observability ─────────────────────────────────────────────────────────────

  /** An immutable view of this Thread's live state. */
  describe(): ThreadSnapshot {
    return {
      chatId: this.chatId,
      numericChatId: this.numeric,
      inFlightCount: this.queuedCount,
      contextActive: this.refCount > 0,
      messagesSent: this.messagesSent,
      warp: this.warpState,
      session: this.session.summary(),
    };
  }
}
