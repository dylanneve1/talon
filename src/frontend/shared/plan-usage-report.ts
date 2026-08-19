/**
 * `/usage` data gathering — plan limits across every backend the config
 * exposes, not just the one serving this chat.
 *
 * Most backends have no plan to report: a gateway (Kilo, OpenCode) bills
 * through whichever provider it fronts, and an API-key install pays per
 * token with no window to be near the end of. Those are listed with a
 * reason rather than omitted, so the answer to "am I close to a limit?" is
 * never silence.
 */

import type { TalonConfig } from "../../util/config.js";
import type { PlanUsage } from "../../core/agent-runtime/capabilities.js";
import {
  listAvailableBackends,
  getPooledBackend,
} from "../../core/engine/backend-controller/index.js";
import { buildPlanDisplay, type PlanDisplay } from "./status-context.js";

export interface BackendUsageEntry {
  id: string;
  label: string;
  /** Rendered windows, or null when this backend reported nothing. */
  plan: PlanDisplay | null;
  /** Why there is nothing to show. Absent when `plan` is set. */
  note?: string;
}

/**
 * One entry per exposed backend, in config order.
 *
 * Only backends already running are queried — booting one to read a
 * number would spawn a subprocess or a server per idle provider, which is
 * far more than a status command should cost.
 */
export async function collectPlanUsage(
  config: TalonConfig,
): Promise<BackendUsageEntry[]> {
  const entries: BackendUsageEntry[] = [];

  for (const { id, label } of listAvailableBackends(config)) {
    const backend = getPooledBackend(id);
    if (!backend) {
      entries.push({ id, label, plan: null, note: "not running" });
      continue;
    }
    if (!backend.usage?.getPlanUsage) {
      entries.push({
        id,
        label,
        plan: null,
        note: "no plan limits on this backend",
      });
      continue;
    }

    let usage: PlanUsage | undefined;
    try {
      usage = await backend.usage.getPlanUsage();
    } catch {
      usage = undefined;
    }
    const plan = buildPlanDisplay(usage);
    entries.push(
      plan
        ? { id, label, plan }
        : { id, label, plan: null, note: "no usage information available" },
    );
  }

  return entries;
}
