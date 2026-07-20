/**
 * Post-restart resume — respawn persistent triggers, fire late wakes for
 * recently-terminated ones, plus the orphan-kill used to avoid duplicate
 * spawns after an unclean crash. The /proc PID-starttime probe both this
 * and spawn use lives in ./pid.ts.
 */

import {
  getAllTriggers,
  updateTrigger,
  RESTART_KILL_ERROR,
  type Trigger,
} from "../../../storage/trigger-store.js";
import { log, logError } from "../../../util/log.js";
import { depsHolder } from "./state.js";
import { fireWake } from "./output.js";
import { spawnTrigger } from "./spawn.js";
import { readPidStarttimeSync } from "./pid.js";

/**
 * After the dispatcher is wired, walk the store and clean up leftover state
 * from a previous run. Triggers in non-terminal states are already marked
 * `terminated` by loadTriggers(); this fires their wake-up so the bot sees
 * what happened the moment it comes back.
 */
export async function resumeAfterRestart(): Promise<void> {
  if (!depsHolder.deps) return;
  for (const t of getAllTriggers()) {
    // Persistent triggers were parked in "pending" by loadTriggers (crash
    // path) or shutdownTriggers (clean path) — respawn them silently. The
    // script body re-runs from the top, so it must be safe to re-run. No wake
    // fire so we don't spam the bot on every Talon restart.
    if (t.persistent && t.status === "pending") {
      if (t.pid !== undefined) {
        killOrphan(t);
        updateTrigger(t.id, { pid: undefined, pidStarttime: undefined });
      }
      try {
        spawnTrigger(t);
        log("triggers", `Respawned persistent trigger "${t.name}" [${t.id}]`);
      } catch (err) {
        logError(
          "triggers",
          `Failed to respawn persistent trigger [${t.id}]`,
          err,
        );
      }
      continue;
    }
    // Late death notice. Two cases earn one:
    //   - never fired at all (the old rule) — the chat heard nothing
    //     from this trigger, so its termination is news; and
    //   - killed by THIS restart (recoverInterrupted stamped the
    //     marker error) — even a multi-fire watcher that signalled
    //     mid-run was still an active promise when the process died,
    //     and without this wake the chat never learns its watcher is
    //     gone. (Previously gated on lastFireAt === undefined alone,
    //     which silently dropped exactly those watchers.)
    // Triggers that exited on their own already fired their terminal
    // wake (lastFireAt set, no marker) — they stay silent here.
    if (
      t.status === "terminated" &&
      t.endedAt &&
      Date.now() - t.endedAt < 5 * 60_000 &&
      (t.lastFireAt === undefined || t.lastError === RESTART_KILL_ERROR)
    ) {
      await fireWake(t.id, "terminated", t.lastError, /* terminal */ true);
    }
  }
}

/**
 * Probe a stored PID from a previous Talon run and SIGKILL it if it's still
 * alive AND really is our former child (not a recycled PID). Used by
 * resumeAfterRestart to avoid duplicate-spawn when Talon crashed outside a
 * cgroup-managed environment.
 *
 * PID-reuse defence (Linux): compare /proc/<pid>/stat field 22 (start time in
 * jiffies) against the value captured at spawn. Start time is monotonic per
 * boot and unchanged by exec(), so a match means the PID still belongs to our
 * process. On non-Linux (no /proc), pidStarttime is undefined and we fall
 * through to SIGKILL.
 */
function killOrphan(t: Trigger): void {
  if (t.pid === undefined) return;
  try {
    process.kill(t.pid, 0);
  } catch {
    return; // dead — nothing to do
  }
  if (t.pidStarttime !== undefined) {
    const current = readPidStarttimeSync(t.pid);
    if (current !== undefined && current !== t.pidStarttime) {
      log(
        "triggers",
        `Orphan probe: pid=${t.pid} starttime ${current} ≠ stored ${t.pidStarttime} — PID reused, leaving alone`,
      );
      return;
    }
  }
  try {
    process.kill(t.pid, "SIGKILL");
    log("triggers", `Killed orphan pid=${t.pid} from previous "${t.name}"`);
  } catch {
    /* raced — exited between probe and kill */
  }
}
