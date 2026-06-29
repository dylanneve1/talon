/**
 * Thread — live per-chat state owned by the Loom.
 *
 * This first pass owns only turn serialization. Later Weaver steps will fold
 * in context, backend binding, and session handles.
 */

export class Thread {
  readonly chatId: string;

  private chain: Promise<unknown> | undefined;
  private queuedCount = 0;

  constructor(chatId: string) {
    this.chatId = chatId;
  }

  get inFlightCount(): number {
    return this.queuedCount;
  }

  get busy(): boolean {
    return this.queuedCount > 0;
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
}
