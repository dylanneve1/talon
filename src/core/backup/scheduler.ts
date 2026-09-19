/**
 * The backup scheduler — one snapshot at a time, forever.
 *
 * Not a task: like the pulse ticker, this is not agent work, so it does
 * not appear in the task table and costs no tokens. It is a timer, a
 * mutex and a backoff window.
 *
 * Timing. The first run is five minutes after boot when the newest
 * snapshot is already older than `intervalHours` (a daemon that restarts
 * often must still back up, but not while it is still booting); if a
 * recent snapshot exists the first run is when that one comes due. Every
 * tick recomputes its own next delay from `Date.now()`, so a clock jump
 * or a suspended laptop resynchronises instead of drifting or stampeding.
 *
 * Serialisation. Every request — scheduled, `/backup now`, a tool, the
 * pre-update hook — goes through one queue. A manual request made while
 * a snapshot is running waits for it rather than racing it, because two
 * `VACUUM INTO`s and two tar streams over the same workspace is how a
 * backup subsystem becomes the reason the daemon is slow.
 *
 * Failure. A failing run backs off (5 → 60 min, shared with the other
 * background agents) and tells the admin ONCE per streak. The daily
 * "backup failed" message nobody reads is worse than no message.
 */

import { FailureBackoff } from "../background/failure-backoff.js";
import { TalonError } from "../errors.js";
import { notifyAdmin } from "../frontend-runtime/admin-notify.js";
import { bus } from "../bus/index.js";
import { log, logError } from "../../util/log.js";
import { dirs } from "../../util/paths.js";
import { buildSnapshot } from "./snapshot.js";
import { listLocalManifests, pruneLocal, reconcileIndex } from "./store.js";
import { discoverTargets, selectTargets } from "./targets.js";
import { pruneRemote, uploadSnapshot } from "./upload.js";
import type { BackupSettings, Manifest, SnapshotKind } from "./types.js";

/** How long after boot the first scheduled snapshot may run. */
export const BOOT_DELAY_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

export type RunRequest = {
  kind: SnapshotKind;
  label?: string;
  pinned?: boolean;
  /** Why this run happened: "schedule", "manual", "pre-update", … */
  trigger: string;
  /** Skip remote upload — used by the pre-restore checkpoint at boot. */
  localOnly?: boolean;
};

/** Test seam: the expensive collaborators, swappable in unit tests. */
export const _backupDeps = {
  build: buildSnapshot,
  discover: discoverTargets,
  upload: uploadSnapshot,
  pruneLocal,
  pruneRemote,
};

type SchedulerState = {
  settings: BackupSettings | null;
  home: string;
  notify: (text: string) => Promise<unknown>;
  timer: ReturnType<typeof setTimeout> | null;
  queue: Promise<unknown>;
  running: boolean;
  /**
   * Set by `stopBackupScheduler`. A tick that is mid-run when shutdown
   * starts still reaches its `schedule()` call afterwards — without this
   * flag it would re-arm the timer the shutdown just cleared, and the
   * daemon would keep a live handle it believes it released.
   */
  stopped: boolean;
  /**
   * Bumped by every init and stop. A timer armed by an earlier
   * configuration (or an earlier test) fires into a scheduler that has
   * since been reconfigured; comparing generations makes that tick a
   * no-op instead of a run nobody asked for.
   */
  generation: number;
  lastRunAt: number;
  lastSnapshotId: string | undefined;
  lastError: string | undefined;
  nextRunAt: number | undefined;
};

const state: SchedulerState = {
  settings: null,
  home: dirs.root,
  notify: notifyAdmin,
  timer: null,
  queue: Promise.resolve(),
  running: false,
  stopped: false,
  generation: 0,
  lastRunAt: 0,
  lastSnapshotId: undefined,
  lastError: undefined,
  nextRunAt: undefined,
};

/**
 * Milliseconds until the first scheduled run. Pure, so the boot-delay and
 * already-recent cases are testable without a clock.
 */
export function firstRunDelayMs(
  newestCreatedAt: number | undefined,
  intervalHours: number,
  now: number,
): number {
  if (newestCreatedAt === undefined) return BOOT_DELAY_MS;
  const due = newestCreatedAt + intervalHours * HOUR_MS;
  return Math.max(BOOT_DELAY_MS, due - now);
}

// ── Runs ────────────────────────────────────────────────────────────────────

const backoff = new FailureBackoff();

async function executeRun(request: RunRequest): Promise<Manifest> {
  const settings = state.settings;
  if (!settings) {
    throw new TalonError("Backup subsystem is not initialised", {
      reason: "bad_request",
    });
  }
  state.running = true;
  const started = Date.now();
  bus.publish({
    type: "backup.started",
    kind: request.kind,
    trigger: request.trigger,
  });
  try {
    const manifest = await _backupDeps.build({
      kind: request.kind,
      label: request.label,
      pinned: request.pinned,
      settings,
      home: state.home,
    });
    state.lastRunAt = Date.now();
    state.lastSnapshotId = manifest.id;
    state.lastError = undefined;
    bus.publish({
      type: "backup.completed",
      snapshotId: manifest.id,
      kind: manifest.kind,
      sizeBytes: manifest.sizeBytes,
      parts: manifest.parts.length,
      durationMs: Date.now() - started,
    });
    await _backupDeps.pruneLocal(settings.keepLocal, state.home);
    if (!request.localOnly) {
      const targets = selectTargets(
        await _backupDeps.discover(),
        settings.targets,
      );
      if (targets.length > 0) {
        await _backupDeps.upload(manifest, targets, state.home);
        await _backupDeps.pruneRemote(targets, settings.keepRemote);
      }
    }
    backoff.succeed();
    return manifest;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.lastError = message;
    const until = backoff.fail(err);
    bus.publish({
      type: "backup.failed",
      trigger: request.trigger,
      error: message,
      consecutiveFailures: backoff.failures,
    });
    logError("backup", `Run failed (${request.trigger})`, err);
    // Once per streak: the second identical failure tells the admin nothing
    // the first one did not.
    if (backoff.failures === 1) {
      await state
        .notify(
          `⚠️ Backup failed: ${message}\nRetrying after ${new Date(until).toISOString().slice(11, 16)} UTC.`,
        )
        .catch(() => {
          /* the notifier logs its own failures */
        });
    }
    throw err;
  } finally {
    state.running = false;
  }
}

/**
 * Take a snapshot. Requests queue behind whatever is already running, so
 * this resolves with THIS request's snapshot, not someone else's.
 */
export function runBackup(request: RunRequest): Promise<Manifest> {
  const result = state.queue.then(
    () => executeRun(request),
    () => executeRun(request),
  );
  state.queue = result.catch(() => undefined);
  return result;
}

// ── The timer ───────────────────────────────────────────────────────────────

function schedule(delayMs: number, generation = state.generation): void {
  if (state.stopped || generation !== state.generation) return;
  if (state.timer) clearTimeout(state.timer);
  state.nextRunAt = Date.now() + delayMs;
  state.timer = setTimeout(() => void tick(generation), delayMs);
  state.timer.unref?.();
}

async function tick(generation: number): Promise<void> {
  const settings = state.settings;
  if (state.stopped || generation !== state.generation || !settings?.enabled) {
    return;
  }
  const intervalMs = settings.intervalHours * HOUR_MS;
  // Recomputed every tick: a suspended machine or a stepped clock lands
  // here late, and the answer is "run now", not "run N missed times".
  if (backoff.active()) {
    schedule(Math.min(intervalMs, BOOT_DELAY_MS), generation);
    return;
  }
  try {
    await runBackup({ kind: "backup", trigger: "schedule" });
  } catch {
    /* executeRun logged, notified and armed the backoff */
  }
  schedule(intervalMs, generation);
}

/**
 * Wire the subsystem and arm the timer. Safe to call with backups
 * disabled — it reconciles the index either way, so the listing surfaces
 * stay truthful on a deployment that only takes manual checkpoints.
 */
export async function initBackup(options: {
  settings: BackupSettings;
  home?: string;
  notify?: (text: string) => Promise<unknown>;
}): Promise<void> {
  state.settings = options.settings;
  state.stopped = false;
  state.generation += 1;
  state.nextRunAt = undefined;
  state.home = options.home ?? dirs.root;
  state.notify = options.notify ?? notifyAdmin;
  await reconcileIndex(state.home);
  const newest = (await listLocalManifests(state.home))[0];
  state.lastRunAt = newest?.createdAt ?? 0;
  state.lastSnapshotId = newest?.id;
  if (!options.settings.enabled) {
    log(
      "backup",
      "Scheduled backups are disabled (config.backup.enabled=false)",
    );
    return;
  }
  const delay = firstRunDelayMs(
    newest?.createdAt,
    options.settings.intervalHours,
    Date.now(),
  );
  schedule(delay);
  log(
    "backup",
    `Scheduled every ${options.settings.intervalHours}h; first run in ` +
      `${Math.round(delay / 60_000)}m (keep ${options.settings.keepLocal} local, ` +
      `${options.settings.keepRemote} remote)`,
  );
}

export function stopBackupScheduler(): void {
  state.stopped = true;
  state.generation += 1;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.nextRunAt = undefined;
}

/** What the status surfaces report about the schedule itself. */
export function schedulerStatus(): {
  enabled: boolean;
  running: boolean;
  intervalHours: number | undefined;
  lastRunAt: number | undefined;
  lastSnapshotId: string | undefined;
  nextRunAt: number | undefined;
  consecutiveFailures: number;
  lastError: string | undefined;
} {
  return {
    enabled: state.settings?.enabled ?? false,
    running: state.running,
    intervalHours: state.settings?.intervalHours,
    lastRunAt: state.lastRunAt || undefined,
    lastSnapshotId: state.lastSnapshotId,
    nextRunAt: state.nextRunAt,
    consecutiveFailures: backoff.failures,
    lastError: state.lastError,
  };
}

/**
 * The self-update hook: a pinned checkpoint before the tree moves, so a
 * bad update is one `talon backup restore` away from undone. Returns the
 * checkpoint id, or null when the feature is off or the subsystem is not
 * initialised (a CLI-driven update in a process with no daemon state).
 * Never throws: failing to take a checkpoint must not block the update.
 */
export async function checkpointBeforeUpdate(
  fromVersion: string,
  toVersion: string,
): Promise<string | null> {
  if (!state.settings?.checkpointBeforeUpdate) return null;
  try {
    const manifest = await runBackup({
      kind: "checkpoint",
      label: `pre-update ${fromVersion}→${toVersion}`,
      pinned: true,
      trigger: "pre-update",
    });
    return manifest.id;
  } catch (err) {
    logError(
      "backup",
      "Pre-update checkpoint failed; continuing with the update",
      err,
    );
    return null;
  }
}

/** The settings this process is running with (surfaces render them). */
export function backupSettings(): BackupSettings | null {
  return state.settings;
}

/** Reset every module-level holder — tests only. */
export function _resetBackupScheduler(): void {
  stopBackupScheduler();
  state.settings = null;
  state.home = dirs.root;
  state.notify = notifyAdmin;
  state.queue = Promise.resolve();
  state.running = false;
  state.lastRunAt = 0;
  state.lastSnapshotId = undefined;
  state.lastError = undefined;
  backoff.succeed();
}
