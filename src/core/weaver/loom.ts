import { Thread } from "./thread.js";

/**
 * Loom — registry of live chat Threads.
 */
export class Loom {
  private readonly threads = new Map<string, Thread>();

  thread(chatId: string): Thread {
    let thread = this.threads.get(chatId);
    if (!thread) {
      thread = new Thread(chatId);
      this.threads.set(chatId, thread);
    }
    return thread;
  }

  get(chatId: string): Thread | undefined {
    return this.threads.get(chatId);
  }

  evict(chatId: string): boolean {
    const thread = this.threads.get(chatId);
    if (!thread || thread.busy) return false;
    return this.threads.delete(chatId);
  }

  size(): number {
    return this.threads.size;
  }

  chatIds(): string[] {
    return [...this.threads.keys()];
  }
}
