/**
 * TalonBus — the daemon's internal event spine.
 *
 * One instance (`bus`) serves the whole process. Producers publish typed
 * events (see events.ts); consumers subscribe by type. The bus is the seam
 * that lets subsystems react to each other without importing each other —
 * bootstrap wires dream and pulse as subscribers instead of threading
 * callbacks through the Weaver, and future work (triggers as subscribers,
 * companion task feeds, mesh presence) lands as more publishers/consumers.
 *
 * Delivery contract:
 *   - Synchronous, in publish order, to every matching subscriber.
 *   - Fire-and-forget: a subscriber that throws (or returns a rejecting
 *     promise) is logged and never affects the publisher or its peers.
 *   - Subscribers must not block: anything slow belongs behind its own
 *     queue or timer, not inside a handler.
 *
 * The bus also keeps a bounded ring of recent events with monotonic ids —
 * the observability surface behind the gateway's `/events/recent` and
 * `talon events`. In-memory only, like the task table: events describe
 * moments in a live process, so there is nothing truthful to persist.
 */

import { logError } from "../../util/log.js";
import type { PublishedEvent, TalonEvent, TalonEventType } from "./events.js";

/** Recent events kept for the tail surfaces. */
const DEFAULT_RECENT_LIMIT = 200;

type Handler<T extends TalonEventType> = (
  event: Extract<PublishedEvent, { type: T }>,
) => void | Promise<void>;

type AnyHandler = (event: PublishedEvent) => void | Promise<void>;

export class TalonBus {
  private readonly byType = new Map<TalonEventType, Set<AnyHandler>>();
  private readonly all = new Set<AnyHandler>();
  private readonly ring: PublishedEvent[] = [];
  private readonly recentLimit: number;
  private nextId = 1;

  constructor(recentLimit = DEFAULT_RECENT_LIMIT) {
    this.recentLimit = recentLimit;
  }

  /** Subscribe to one event type. Returns the unsubscribe function. */
  subscribe<T extends TalonEventType>(
    type: T,
    handler: Handler<T>,
  ): () => void {
    const set = this.byType.get(type) ?? new Set<AnyHandler>();
    this.byType.set(type, set);
    const anyHandler = handler as AnyHandler;
    set.add(anyHandler);
    return () => {
      set.delete(anyHandler);
    };
  }

  /** Subscribe to every event (tails, forwarders). Returns unsubscribe. */
  subscribeAll(handler: AnyHandler): () => void {
    this.all.add(handler);
    return () => {
      this.all.delete(handler);
    };
  }

  /** Stamp and deliver an event. Never throws. */
  publish(event: TalonEvent): PublishedEvent {
    const published: PublishedEvent = {
      ...event,
      id: this.nextId++,
      at: Date.now(),
    };
    this.ring.push(published);
    if (this.ring.length > this.recentLimit) {
      this.ring.splice(0, this.ring.length - this.recentLimit);
    }
    for (const handler of this.byType.get(event.type) ?? []) {
      this.deliver(handler, published);
    }
    for (const handler of this.all) {
      this.deliver(handler, published);
    }
    return published;
  }

  /**
   * Recent events, id-ascending — all of the ring, or only those after
   * `sinceId` (the tail-follow cursor).
   */
  recent(sinceId = 0): PublishedEvent[] {
    return sinceId > 0
      ? this.ring.filter((event) => event.id > sinceId)
      : [...this.ring];
  }

  private deliver(handler: AnyHandler, event: PublishedEvent): void {
    try {
      const result = handler(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          logError("bus", `Subscriber for ${event.type} rejected`, err);
        });
      }
    } catch (err) {
      logError("bus", `Subscriber for ${event.type} threw`, err);
    }
  }
}

/** The daemon-wide bus. Tests needing isolation construct their own. */
export const bus = new TalonBus();
