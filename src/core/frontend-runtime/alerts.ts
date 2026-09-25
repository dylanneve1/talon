/**
 * Operator alerts — "something is wrong" (and "it's fine again") on the
 * admin's chat, deduplicated so a flapping fault can't flood it.
 *
 * Every alert has a stable key naming the fault ("telegram.polling",
 * "backend.auth", "disk.low"). The first raise delivers; repeats inside
 * the cooldown only count, and the next delivery after it says how many
 * were folded in. `resolveAlert` sends one recovery notice for a key that
 * was delivered, and nothing for one that never was. Delivery rides
 * `notifyAdmin`, so alerts degrade to a log line when no frontend is up.
 */

import { log, logWarn } from "../../util/log.js";
import { notifyAdmin } from "./admin-notify.js";

export type AlertSeverity = "warn" | "error" | "critical";

type ActiveAlert = {
  severity: AlertSeverity;
  message: string;
  firstAt: number;
  lastSentAt: number;
  /** Raises folded into the cooldown since the last delivery. */
  suppressed: number;
};

const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const ICON: Record<AlertSeverity, string> = {
  warn: "⚠️",
  error: "🔴",
  critical: "🚨",
};

const active = new Map<string, ActiveAlert>();
let cooldownMs = DEFAULT_COOLDOWN_MS;
let enabled = true;
let send: (text: string) => Promise<unknown> = notifyAdmin;

/** Apply operator settings (config `alerts`). */
export function configureAlerts(opts: {
  enabled?: boolean;
  cooldownMs?: number;
}): void {
  if (opts.enabled !== undefined) enabled = opts.enabled;
  if (opts.cooldownMs !== undefined && opts.cooldownMs >= 0)
    cooldownMs = opts.cooldownMs;
}

/**
 * Report a fault. Always logged; delivered to the admin unless the same
 * key was delivered within the cooldown. Never throws.
 */
export function raiseAlert(
  key: string,
  message: string,
  opts: { severity?: AlertSeverity } = {},
): void {
  const severity = opts.severity ?? "error";
  const now = Date.now();
  logWarn("alert", `[${severity}] ${key}: ${message}`);
  const prior = active.get(key);
  if (prior && now - prior.lastSentAt < cooldownMs) {
    prior.suppressed++;
    prior.message = message;
    return;
  }
  const folded = prior?.suppressed ?? 0;
  active.set(key, {
    severity,
    message,
    firstAt: prior?.firstAt ?? now,
    lastSentAt: now,
    suppressed: 0,
  });
  if (!enabled) return;
  const repeat = folded > 0 ? `\n(+${folded} more since the last alert)` : "";
  void send(`${ICON[severity]} ${message}${repeat}`).catch(() => {});
}

/** Clear a fault; announces recovery only if its alert was delivered. */
export function resolveAlert(key: string, message?: string): void {
  const prior = active.get(key);
  if (!prior) return;
  active.delete(key);
  const mins = Math.max(1, Math.round((Date.now() - prior.firstAt) / 60_000));
  log("alert", `resolved ${key} after ${mins} min`);
  if (!enabled) return;
  void send(`✅ ${message ?? `Recovered: ${key}`} (after ${mins} min)`).catch(
    () => {},
  );
}

/** Keys currently raised — for status surfaces and doctor. */
export function activeAlerts(): ReadonlyArray<{
  key: string;
  severity: AlertSeverity;
  message: string;
  since: number;
}> {
  return [...active].map(([key, a]) => ({
    key,
    severity: a.severity,
    message: a.message,
    since: a.firstAt,
  }));
}

/** Test seam: reset state and swap the delivery function. */
export function resetAlertsForTest(
  deliver: (text: string) => Promise<unknown> = notifyAdmin,
): void {
  active.clear();
  cooldownMs = DEFAULT_COOLDOWN_MS;
  enabled = true;
  send = deliver;
}
