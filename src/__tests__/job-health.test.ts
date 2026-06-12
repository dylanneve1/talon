/**
 * job-health — per-cron-job circuit breakers built on the Gleam
 * scheduler core. Verifies the policy the cron tick relies on:
 * failures open the breaker, cooldowns escalate per re-open, a
 * half-open probe is allowed after cooling down, and success resets.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  jobAllowsRun,
  pruneJobHealth,
  recordJobFailure,
  recordJobSuccess,
  resetJobHealth,
} from "../core/background/job-health.js";

const OPTS = {
  threshold: 3,
  baseCooldownMs: 5 * 60_000,
  maxCooldownMs: 6 * 60 * 60_000,
};

const T0 = 1_750_000_000_000;

beforeEach(() => resetJobHealth());

describe("job-health breaker", () => {
  it("allows healthy jobs to run", () => {
    expect(jobAllowsRun("job-a", T0, OPTS)).toBe(true);
  });

  it("stays closed below the failure threshold", () => {
    expect(recordJobFailure("job-a", T0, OPTS)).toBeNull();
    expect(recordJobFailure("job-a", T0 + 1, OPTS)).toBeNull();
    expect(jobAllowsRun("job-a", T0 + 2, OPTS)).toBe(true);
  });

  it("opens at the threshold and reports the cooldown", () => {
    recordJobFailure("job-a", T0, OPTS);
    recordJobFailure("job-a", T0 + 1, OPTS);
    const cooldown = recordJobFailure("job-a", T0 + 2, OPTS);
    expect(cooldown).not.toBeNull();
    // ±25% jitter around the 5-minute base.
    expect(cooldown!).toBeGreaterThanOrEqual(OPTS.baseCooldownMs * 0.75);
    expect(cooldown!).toBeLessThanOrEqual(OPTS.baseCooldownMs * 1.25);
    expect(jobAllowsRun("job-a", T0 + 3, OPTS)).toBe(false);
  });

  it("allows a half-open probe after the cooldown elapses", () => {
    recordJobFailure("job-a", T0, OPTS);
    recordJobFailure("job-a", T0 + 1, OPTS);
    const cooldown = recordJobFailure("job-a", T0 + 2, OPTS)!;
    expect(jobAllowsRun("job-a", T0 + 2 + cooldown - 1, OPTS)).toBe(false);
    expect(jobAllowsRun("job-a", T0 + 2 + cooldown, OPTS)).toBe(true);
  });

  it("closes again after a successful probe", () => {
    recordJobFailure("job-a", T0, OPTS);
    recordJobFailure("job-a", T0 + 1, OPTS);
    const cooldown = recordJobFailure("job-a", T0 + 2, OPTS)!;
    expect(jobAllowsRun("job-a", T0 + 2 + cooldown + 1, OPTS)).toBe(true); // half-open probe
    recordJobSuccess("job-a", T0 + 2 + cooldown + 2, OPTS);
    expect(jobAllowsRun("job-a", T0 + 2 + cooldown + 3, OPTS)).toBe(true);
  });

  it("escalates the cooldown when the probe fails again", () => {
    recordJobFailure("job-a", T0, OPTS);
    recordJobFailure("job-a", T0 + 1, OPTS);
    const first = recordJobFailure("job-a", T0 + 2, OPTS)!;
    jobAllowsRun("job-a", T0 + 2 + first + 1, OPTS); // half-open
    const second = recordJobFailure("job-a", T0 + 2 + first + 2, OPTS)!;
    // Second open: base doubles (jitter can't close a 2x gap at ±25%).
    expect(second).toBeGreaterThan(first);
  });

  it("tracks jobs independently", () => {
    for (let i = 0; i < 3; i++) recordJobFailure("job-a", T0 + i, OPTS);
    expect(jobAllowsRun("job-a", T0 + 10, OPTS)).toBe(false);
    expect(jobAllowsRun("job-b", T0 + 10, OPTS)).toBe(true);
  });

  it("prunes state for deleted jobs", () => {
    for (let i = 0; i < 3; i++) recordJobFailure("job-a", T0 + i, OPTS);
    expect(jobAllowsRun("job-a", T0 + 10, OPTS)).toBe(false);
    pruneJobHealth(new Set(["job-b"]));
    // job-a was pruned — fresh slate.
    expect(jobAllowsRun("job-a", T0 + 11, OPTS)).toBe(true);
  });
});
