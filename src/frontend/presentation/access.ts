/**
 * Access-gate primitives shared by the chat frontends.
 *
 * Telegram and Discord each carried their own copy of the same three
 * mechanisms — a per-sender sliding-window rate limiter, a bounded
 * first-seen set for "new DM user" logging, and a keyed cooldown for
 * unauthorized-access notices — differing only in the sender-id type.
 * The copies had identical bodies and identical magic numbers; this is
 * the one implementation, generic over the id.
 *
 * What is NOT here: the allow/deny semantics themselves. Telegram gates
 * on a user allowlist/denylist plus admin group membership; Discord on
 * users, guilds, channels, and a respond mode. Those are platform
 * policy and stay with each frontend.
 */

import { appendDailyLog } from "../../storage/daily-log.js";
import { log, logDebug } from "../../util/log.js";

// ── Rate limiter ────────────────────────────────────────────────────────────

export interface RateLimiterOptions {
  /** Sliding window length. */
  windowMs: number;
  /** Messages allowed per sender inside one window. */
  maxMessages: number;
  /**
   * When the tracked-sender map grows past this, senders idle for
   * `staleAfterMs` are evicted until the map is at `evictTo` or the scan
   * completes. Bounds memory under a flood of distinct senders.
   */
  evictAbove?: number;
  evictTo?: number;
  staleAfterMs?: number;
}

export interface RateLimiter<Id> {
  /**
   * Record one message from `id` and report whether it exceeded the
   * window. A limited message is NOT recorded, so the sender is admitted
   * again as soon as the oldest timestamp ages out.
   */
  isLimited(id: Id): boolean;
}

export function createRateLimiter<Id>(
  options: RateLimiterOptions,
): RateLimiter<Id> {
  const {
    windowMs,
    maxMessages,
    evictAbove = 5_000,
    evictTo = 2_500,
    staleAfterMs = 10 * 60_000,
  } = options;
  const timestamps = new Map<Id, number[]>();

  return {
    isLimited(id) {
      const now = Date.now();
      let ts = timestamps.get(id);
      if (!ts) {
        ts = [];
        timestamps.set(id, ts);
      }
      // Drop entries that have aged out of the window.
      while (ts.length > 0 && ts[0] < now - windowMs) ts.shift();

      if (ts.length >= maxMessages) {
        logDebug("bot", `Rate-limited user ${String(id)}`);
        return true;
      }
      ts.push(now);

      if (timestamps.size > evictAbove) {
        const cutoff = now - staleAfterMs;
        for (const [sender, list] of timestamps) {
          if (list.length === 0 || list[list.length - 1] < cutoff) {
            timestamps.delete(sender);
          }
          if (timestamps.size <= evictTo) break;
        }
      }
      return false;
    },
  };
}

// ── First-seen DM users ─────────────────────────────────────────────────────

export interface DmUserTracker<Id> {
  /**
   * Log the first message from a sender (talon.log + daily log). No-op
   * for senders already seen. `tag` is an optional handle rendered in
   * parentheses after the name, e.g. `@alice`.
   */
  track(id: Id, senderName: string, tag?: string): void;
}

/**
 * Insertion-ordered set capped at `cap`; on overflow the oldest 10% are
 * evicted so a flood of one-off senders cannot grow it without bound.
 */
export function createDmUserTracker<Id>(cap: number): DmUserTracker<Id> {
  const seen = new Set<Id>();
  return {
    track(id, senderName, tag) {
      if (seen.has(id)) return;
      if (seen.size >= cap) {
        const evictCount = Math.floor(cap * 0.1);
        const iter = seen.values();
        for (let i = 0; i < evictCount; i++) {
          seen.delete(iter.next().value as Id);
        }
      }
      seen.add(id);
      const tagStr = tag ? ` (${tag})` : "";
      const line = `New DM user: ${senderName}${tagStr} [id:${String(id)}]`;
      log("users", line);
      appendDailyLog("System", line);
    },
  };
}

// ── Notice cooldown ─────────────────────────────────────────────────────────

export interface NoticeCooldown {
  /**
   * Whether a notice for `key` should fire now. Returns true at most once
   * per `ttlMs` per key, recording the send. The map is cleared outright
   * at `cap` entries — cheaper than an LRU and the worst case is one
   * extra notice per key.
   */
  shouldNotify(key: string): boolean;
}

export function createNoticeCooldown(options: {
  ttlMs: number;
  cap: number;
}): NoticeCooldown {
  const last = new Map<string, number>();
  return {
    shouldNotify(key) {
      const now = Date.now();
      const previous = last.get(key);
      if (previous && now - previous < options.ttlMs) return false;
      if (last.size >= options.cap) last.clear();
      last.set(key, now);
      return true;
    },
  };
}
