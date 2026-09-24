/**
 * Auth guard — how the bridge answers credentials that don't check out.
 *
 * The token itself is the security (256 bits when Talon mints it); this
 * module decides how a wrong one is answered so an internet-facing bridge
 * can't be hammered for free, and so the operator hears about it.
 *
 * Three layers, all keyed on the remote address (behind a reverse proxy that
 * is the proxy):
 *
 *   1. Progressive backoff: the first few wrong tokens from an address get an
 *      immediate 401; after that each 401 waits longer (base doubling to a
 *      cap). Only failures wait. A correct token is never delayed.
 *   2. Lockout: after `lockoutMaxFailures` wrong tokens in the window the
 *      address gets 429s (even with the right token) until the window lapses.
 *   3. Global failure budget: if wrong tokens across ALL addresses exceed
 *      `globalMaxFailures` in `globalWindowMs`, that is distributed guessing
 *      dodging (1) and (2). The bridge enters a cooldown: wrong tokens get
 *      429 at once, tokenless requests are slowed, the operator is alerted
 *      once. Authenticated traffic keeps working throughout.
 *
 * Only presented-and-wrong tokens count as failures. Tokenless probes are
 * scanners finding a locked door. Waits are timers, never a blocked event
 * loop, and the number of responses held at once is capped so the delays
 * can't be turned into a socket-exhaustion lever.
 *
 * Every event logs one `bridge.auth event=…` line with the address and a
 * reason. Token material never reaches this module.
 */

import { log, logWarn } from "../../../util/log.js";
import type { AuthState } from "./routes/table.js";

export type AuthGuardPolicy = {
  /** Wrong tokens from one address inside the window before 429s. */
  lockoutMaxFailures: number;
  lockoutWindowMs: number;
  /** Hard cap on tracked addresses so the map can't become a memory lever. */
  maxTracked: number;
  /** Wrong tokens answered without delay (typos happen). */
  freeFailures: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Wrong tokens across every address, per window, before a cooldown. */
  globalMaxFailures: number;
  globalWindowMs: number;
  globalCooldownMs: number;
  /** How long a tokenless request is held during a cooldown. */
  cooldownAnonDelayMs: number;
  /** Most responses held at once; past this, refuse instead of waiting. */
  maxPendingDelays: number;
};

const DEFAULT_AUTH_GUARD_POLICY: AuthGuardPolicy = {
  lockoutMaxFailures: 20,
  lockoutWindowMs: 15 * 60_000,
  maxTracked: 10_000,
  freeFailures: 2,
  backoffBaseMs: 250,
  backoffMaxMs: 8_000,
  globalMaxFailures: 100,
  globalWindowMs: 5 * 60_000,
  globalCooldownMs: 10 * 60_000,
  cooldownAnonDelayMs: 1_000,
  maxPendingDelays: 512,
};

export type AuthVerdict =
  | { kind: "allow" }
  /** Hold the response this long, then carry on as normal. */
  | { kind: "delay"; ms: number }
  | {
      kind: "reject";
      reason: "lockout" | "cooldown";
      retryAfterSec: number;
    };

type Entry = { count: number; resetAt: number };

export class AuthGuard {
  private readonly policy: AuthGuardPolicy;
  private readonly now: () => number;
  private readonly onAlert: ((message: string) => void) | undefined;
  private readonly failures = new Map<string, Entry>();
  private globalCount = 0;
  private globalWindowStart = 0;
  private cooldownUntil = 0;
  private cooling = false;
  private suppressed = 0;
  private saturatedLogged = false;
  private pending = 0;

  constructor(
    policy: Partial<AuthGuardPolicy> = {},
    deps: { now?: () => number; onAlert?: (message: string) => void } = {},
  ) {
    this.policy = { ...DEFAULT_AUTH_GUARD_POLICY, ...policy };
    this.now = deps.now ?? Date.now;
    this.onAlert = deps.onAlert;
  }

  /** Addresses currently tracked (tests and diagnostics). */
  trackedCount(): number {
    return this.failures.size;
  }

  /** True while the global failure budget is exhausted. */
  inCooldown(): boolean {
    this.refreshCooldown(this.now());
    return this.cooling;
  }

  /**
   * Decide how to answer a request whose credential has been evaluated.
   * Called once per request, before routing.
   */
  check(remote: string, auth: AuthState): AuthVerdict {
    const now = this.now();
    this.refreshCooldown(now);
    const entry = this.liveEntry(remote, now);
    if (entry && entry.count >= this.policy.lockoutMaxFailures) {
      return {
        kind: "reject",
        reason: "lockout",
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }
    if (auth === "ok") {
      this.failures.delete(remote);
      return { kind: "allow" };
    }
    if (auth === "anonymous") {
      return this.cooling
        ? { kind: "delay", ms: this.policy.cooldownAnonDelayMs }
        : { kind: "allow" };
    }
    return this.fail(remote, now);
  }

  /**
   * Wait `ms` on a timer. Resolves false, without waiting, when too many
   * responses are already held — the caller refuses instead.
   */
  async hold(ms: number): Promise<boolean> {
    if (this.pending >= this.policy.maxPendingDelays) return false;
    this.pending++;
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref?.();
      });
      return true;
    } finally {
      this.pending--;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private fail(remote: string, now: number): AuthVerdict {
    const count = this.recordFailure(remote, now);
    this.recordGlobalFailure(now);
    if (this.cooling) {
      this.suppressed++;
      return {
        kind: "reject",
        reason: "cooldown",
        retryAfterSec: Math.max(
          1,
          Math.ceil((this.cooldownUntil - now) / 1000),
        ),
      };
    }
    const delay = count === null ? 0 : this.backoffFor(count);
    logWarn(
      "native",
      `bridge.auth event=failure addr=${remote} reason=bad_token` +
        (count === null ? " tracked=no" : ` failures=${count}`) +
        ` delayMs=${delay}`,
    );
    if (count === this.policy.lockoutMaxFailures) {
      logWarn(
        "native",
        `bridge.auth event=lockout addr=${remote} reason=too_many_failures failures=${count} windowMin=${this.policy.lockoutWindowMs / 60_000}`,
      );
    }
    return delay > 0 ? { kind: "delay", ms: delay } : { kind: "allow" };
  }

  private backoffFor(count: number): number {
    const n = count - this.policy.freeFailures;
    if (n <= 0) return 0;
    // 2^(n-1) overflows nothing useful past ~30 doublings; clamp first.
    const factor = 2 ** Math.min(n - 1, 30);
    return Math.min(
      this.policy.backoffMaxMs,
      this.policy.backoffBaseMs * factor,
    );
  }

  private liveEntry(remote: string, now: number): Entry | undefined {
    const entry = this.failures.get(remote);
    if (entry && now >= entry.resetAt) {
      this.failures.delete(remote);
      return undefined;
    }
    return entry;
  }

  /** Bump the address's count; null when the address couldn't be tracked. */
  private recordFailure(remote: string, now: number): number | null {
    const entry = this.liveEntry(remote, now);
    if (entry) return ++entry.count;
    if (this.failures.size >= this.policy.maxTracked) {
      for (const [ip, e] of this.failures) {
        if (now >= e.resetAt) this.failures.delete(ip);
      }
      // Still saturated after pruning live entries — under that much churn
      // dropping the newest address beats unbounded growth. The global
      // budget still counts it.
      if (this.failures.size >= this.policy.maxTracked) {
        if (!this.saturatedLogged) {
          this.saturatedLogged = true;
          logWarn(
            "native",
            `bridge.auth event=tracking_saturated reason=address_cap tracked=${this.failures.size}`,
          );
        }
        return null;
      }
    }
    this.saturatedLogged = false;
    this.failures.set(remote, {
      count: 1,
      resetAt: now + this.policy.lockoutWindowMs,
    });
    return 1;
  }

  private recordGlobalFailure(now: number): void {
    if (now - this.globalWindowStart >= this.policy.globalWindowMs) {
      this.globalWindowStart = now;
      this.globalCount = 0;
    }
    this.globalCount++;
    if (this.globalCount <= this.policy.globalMaxFailures) return;
    // Sustained guessing keeps pushing the end of the cooldown out.
    this.cooldownUntil = now + this.policy.globalCooldownMs;
    if (this.cooling) return;
    this.cooling = true;
    this.suppressed = 0;
    const message =
      `bridge.auth event=global_cooldown reason=failure_budget failures=${this.globalCount} ` +
      `windowSec=${this.policy.globalWindowMs / 1000} cooldownSec=${this.policy.globalCooldownMs / 1000}`;
    logWarn("native", message);
    try {
      this.onAlert?.(
        `⚠️ Talon bridge: ${this.globalCount} failed auth attempts across all addresses in ` +
          `${this.policy.globalWindowMs / 60_000} min, which looks like distributed token guessing ` +
          "(or a token rotation left devices with a stale token). Failed and tokenless " +
          `requests are being refused or slowed for ${this.policy.globalCooldownMs / 60_000} min; ` +
          "paired clients are unaffected.",
      );
    } catch {
      // An alert that can't be delivered must never break request handling.
    }
  }

  private refreshCooldown(now: number): void {
    if (!this.cooling || now < this.cooldownUntil) return;
    this.cooling = false;
    log(
      "native",
      `bridge.auth event=global_cooldown_end reason=expired refused=${this.suppressed}`,
    );
    this.suppressed = 0;
  }
}
