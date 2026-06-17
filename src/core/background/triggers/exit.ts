/**
 * Trigger lifecycle endings — timeout, cancel, shutdown, child kill, the
 * authoritative `finalizeExit` settlement, and the `failTrigger` fail-to-spawn
 * path.
 */

import type { ChildProcess } from "node:child_process";
import {
  getTrigger,
  persistNow,
  updateTrigger,
  type Trigger,
  type TriggerStatus,
} from "../../../storage/trigger-store.js";
import { log, logError } from "../../../util/log.js";
import { appendDailyLog } from "../../../storage/daily-log.js";
import {
  children,
  timeouts,
  logStreams,
  lineBuffers,
  wardened,
  SIGTERM_GRACE_MS,
  WARDEN_GRACE_SLACK_MS,
} from "./state.js";
import { bufferAsPayload, fireWake } from "./output.js";

export function handleTimeout(trigger: Trigger): void {
  timeouts.delete(trigger.id);
  const c = children.get(trigger.id);
  if (!c) return;
  log(
    "triggers",
    `Timeout for "${trigger.name}" [${trigger.id}] after ${trigger.timeoutSeconds}s — killing`,
  );
  updateTrigger(trigger.id, {
    status: "timed_out",
    lastError: `Timed out after ${trigger.timeoutSeconds}s`,
  });
  // Terminal status — persist now so a crash before the 10s autosave doesn't
  // leave us thinking this trigger is still "running" on next load.
  persistNow();
  killChild(trigger.id, c);
}

/** Cancel a running trigger. Idempotent. */
export function cancelTrigger(id: string): boolean {
  const child = children.get(id);
  if (!child) return false;
  updateTrigger(id, {
    status: "cancelled",
    lastError: "Cancelled by user",
  });
  // Terminal status — persist now so cancel survives a crash before autosave.
  persistNow();
  killChild(id, child);
  return true;
}

/** Kill all running children — called during shutdown. */
export async function shutdownTriggers(): Promise<void> {
  if (children.size === 0) return;
  log("triggers", `Shutting down ${children.size} running trigger(s)`);
  const ids = Array.from(children.keys());
  for (const id of ids) {
    const c = children.get(id);
    if (!c) continue;
    const t = getTrigger(id);
    if (t?.persistent) {
      // Park persistent triggers in "pending" so resumeAfterRestart() respawns
      // them on next startup. Keep the stored pid — finalizeExit clears it when
      // the child actually exits. If the child explicitly ignores SIGTERM and
      // outlives Talon, the pid survives to disk so the next boot's
      // resumeAfterRestart() can SIGKILL the orphan before respawning.
      updateTrigger(id, { status: "pending" });
    } else {
      updateTrigger(id, {
        status: "terminated",
        lastError: "Killed by Talon shutdown",
      });
    }
    killChild(id, c);
  }
  // Give children a brief grace window to actually exit so logs flush
  await new Promise((r) => setTimeout(r, 250));
}

export function killChild(id: string, child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already dead */
  }
  // Warden handles forward the TERM to the child's process group and run their
  // own grace escalation — give them headroom to finish it before the
  // last-resort SIGKILL here.
  const graceMs = wardened.has(id)
    ? SIGTERM_GRACE_MS + WARDEN_GRACE_SLACK_MS
    : SIGTERM_GRACE_MS;
  const grace = setTimeout(() => {
    if (children.has(id)) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }
  }, graceMs);
  grace.unref();
}

export async function finalizeExit(
  id: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  children.delete(id);
  wardened.delete(id);
  const timer = timeouts.get(id);
  if (timer) {
    clearTimeout(timer);
    timeouts.delete(id);
  }

  const stream = logStreams.get(id);
  if (stream) {
    // Await the flush so any caller observing `status === "fired"` is
    // guaranteed to find the exit footer on disk.
    stream.write(`--- exit code=${code} signal=${signal} ---\n`);
    await new Promise<void>((resolve) => stream.end(resolve));
    logStreams.delete(id);
  }

  const buffered = lineBuffers.get(id) ?? [];
  lineBuffers.delete(id);

  const t = getTrigger(id);
  if (!t) return;

  // Status was already set by cancel/timeout/shutdown handlers — only set a
  // terminal status here if the child exited on its own.
  let status: TriggerStatus = t.status;
  let payload: string | undefined;

  // Persistent triggers parked as "pending" by shutdownTriggers must stay
  // "pending" so resumeAfterRestart respawns them on next boot. Skip the
  // status-rewrite and the endedAt stamp; just clear the PID and persist.
  if (t.persistent && t.status === "pending") {
    updateTrigger(id, { pid: undefined, pidStarttime: undefined });
    persistNow();
    log(
      "triggers",
      `Exited (persistent) "${t.name}" [${id}] code=${code} signal=${signal} — will respawn on next start`,
    );
    return;
  }

  if (t.status === "running" || t.status === "pending") {
    if (code === 0) {
      status = "fired";
      payload = bufferAsPayload(buffered);
    } else {
      status = "errored";
      payload = bufferAsPayload(buffered, code ?? undefined);
    }
  } else {
    payload = bufferAsPayload(buffered);
  }

  updateTrigger(id, {
    status,
    endedAt: Date.now(),
    pid: undefined,
    pidStarttime: undefined,
    exitCode: code ?? undefined,
  });
  // Terminal status reached — persist immediately so a crash between here and
  // the next autosave tick doesn't lose the exit transition.
  persistNow();

  log(
    "triggers",
    `Exited "${t.name}" [${id}] code=${code} signal=${signal} → ${status}`,
  );

  appendDailyLog(
    "Triggers",
    `Trigger "${t.name}" ended with status=${status}${
      code != null ? ` code=${code}` : ""
    }`,
  );

  // Fire a wake-up for terminal statuses so the bot sees what happened
  if (
    status === "fired" ||
    status === "errored" ||
    status === "timed_out" ||
    status === "cancelled" ||
    status === "terminated"
  ) {
    await fireWake(id, status, payload, /* terminal */ true);
  }
}

export function failTrigger(t: Trigger, message: string): void {
  logError("triggers", `Failed to spawn ${t.id}: ${message}`);
  updateTrigger(t.id, {
    status: "errored",
    lastError: message,
    endedAt: Date.now(),
  });
  // Terminal status — persist immediately. Callers like trigger_create re-read
  // the store right after spawnTrigger() returns and must see "errored", not a
  // stale snapshot from before the dirty flag is flushed.
  persistNow();
}
