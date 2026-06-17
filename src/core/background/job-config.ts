/**
 * Decoupled-jobs feature gate.
 *
 * Per-job model/provider overrides (a trigger or cron running on a cheaper model
 * or a different provider, possibly in an isolated session) are OFF by default.
 * A deployment opts in via `config.decoupledJobs`; until then the override
 * fields on triggers/cron are rejected at create time and ignored at fire time,
 * so behaviour is unchanged.
 *
 * Kept as a tiny module-level flag (set once at bootstrap) so both the gateway
 * create handlers and the cron/trigger executors can read it without threading
 * config through every call site.
 */

let enabled = false;

/** Set the gate from config at startup. */
export function setDecoupledJobsEnabled(value: boolean): void {
  enabled = value;
}

/** True when per-job model/provider overrides are allowed. */
export function decoupledJobsEnabled(): boolean {
  return enabled;
}
