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

export class Thread {
  readonly chatId: string;

  // ── Serialization (per-chat FIFO) ──────────────────────────────────────────
  private chain: Promise<unknown> | undefined;
  private queuedCount = 0;

  // ── Execution context (per-turn; absorbed from gateway ChatContext) ─────────
  private refCount = 0;
  private messagesSent = 0;
  private numeric: number | undefined;

  constructor(chatId: string) {
    this.chatId = chatId;
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
}
