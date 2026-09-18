/**
 * Per-turn CPU accounting — how much of a turn the daemon itself spends
 * on a CPU, as opposed to waiting on a model or a chat platform.
 *
 * This is the number Phase 0's kill criterion is written against
 * (docs/ts-migration-plan.md): the TS control plane's share of turn
 * latency is `turn.cpu_ms / response_latency_ms`, and if that share is
 * small then a port buys latency nothing. `turn.stream_ms` is the wall
 * clock over the identical bracket, so the two divide cleanly.
 *
 * `process.cpuUsage()` is process-wide, not per-turn: with concurrent
 * turns each one's delta includes the others' work. That is the honest
 * upper bound for "what the daemon costs while a turn is in flight", and
 * it is the direction that matters — a small number stays small.
 */

import { recordHistogram } from "../../storage/metrics.js";

/**
 * Bracket a turn's backend stream. Returns the stop function; calling it
 * records `turn.cpu_ms` (user + system, milliseconds).
 */
export function startTurnCpu(): () => void {
  const startedAt = process.cpuUsage();
  return () => {
    const used = process.cpuUsage(startedAt);
    recordHistogram(
      "turn.cpu_ms",
      Math.round((used.user + used.system) / 1000),
    );
  };
}
