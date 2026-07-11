/**
 * Heartbeat shared state — the in-process run guard + timers + config ref,
 * the persisted state-file shape, and its read/write helpers.
 *
 * The scheduler and agent submodules both read/write this state, so the
 * mutable fields live on a single `hb` holder object imported by both.
 */

import { files as pathFiles } from "../../../util/paths.js";
import { kvGet, kvSet } from "../../../storage/kv.js";
import { importLegacyJson } from "../../../storage/legacy-import.js";
import type { Backend } from "../../agent-runtime/capabilities.js";

export type HeartbeatState = {
  /** Unix millisecond timestamp of the last successfully completed heartbeat run. */
  last_run: number;
  /** Human-readable ISO timestamp of the last successfully completed heartbeat run. */
  last_run_at?: string;
  /** Unix millisecond timestamp of the last time a heartbeat was started (success or failure). */
  last_started?: number;
  /** "idle" when no heartbeat is running, "running" while one is active. */
  status: "idle" | "running";
  /** Total number of successfully completed heartbeat runs. */
  run_count: number;
};

export type HeartbeatConfig = {
  model?: string;
  heartbeatModel?: string;
  workspace?: string;
  /**
   * Accessor for the active backend — invoked each time a heartbeat fires so
   * backend hot-swaps performed by the controller take effect on the next
   * heartbeat without an `initHeartbeat` recall.
   */
  getBackend?: () => Backend | null;
  /**
   * Non-terminal frontends present at startup. Used to render the outbound
   * messaging section of the heartbeat system prompt. Empty for terminal-only
   * deployments.
   */
  frontends?: readonly string[];
  /**
   * MemPalace presence flag — when true, the prompt tells the agent to recall
   * palace context before working a goal and store learnings afterwards.
   */
  mempalace?: boolean;
};

/**
 * kv key owning the persisted heartbeat state. The blob used to live at
 * `pathFiles.heartbeatState` as hand-rolled JSON; it now rides the shared
 * `kv` table so it inherits transactional writes and TALON_DB_PATH test
 * isolation like the rest of the unified storage layer.
 */
const HEARTBEAT_STATE_KEY = "heartbeat.state";

/**
 * Mutable heartbeat runtime state, shared across submodules:
 *   - `running` / `currentRunPromise` — the one-at-a-time run guard
 *   - `timer` / `startupTimer` — the cadence timers
 *   - `intervalMinutesRef` — interval captured from startHeartbeatTimer
 *   - `config` — injected via initHeartbeat
 *   - `logFileSequence` — monotonic per-run log filename counter
 */
export const hb: {
  running: boolean;
  currentRunPromise: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
  startupTimer: ReturnType<typeof setTimeout> | null;
  intervalMinutesRef: number;
  config: HeartbeatConfig | null;
  logFileSequence: number;
  /** Consecutive failed runs — drives the failure backoff curve. */
  consecutiveFailures: number;
  /** Epoch ms before which auto runs are suppressed after a failure. */
  backoffUntil: number;
} = {
  running: false,
  currentRunPromise: null,
  timer: null,
  startupTimer: null,
  intervalMinutesRef: 60,
  config: null,
  logFileSequence: 0,
  consecutiveFailures: 0,
  backoffUntil: 0,
};

// ── State-file I/O ───────────────────────────────────────────────────────────

function normalizeHeartbeatState(parsed: unknown): HeartbeatState | null {
  if (!parsed || typeof parsed !== "object") return null;

  const candidate = parsed as Record<string, unknown>;
  const { last_run, last_run_at, last_started, status, run_count } = candidate;

  if (typeof last_run !== "number" || !Number.isFinite(last_run)) return null;
  if (typeof run_count !== "number" || !Number.isFinite(run_count)) return null;
  if (status !== "idle" && status !== "running") return null;
  if (last_run_at !== undefined && typeof last_run_at !== "string") return null;
  if (
    last_started !== undefined &&
    (typeof last_started !== "number" || !Number.isFinite(last_started))
  ) {
    return null;
  }

  return {
    last_run,
    run_count,
    status,
    ...(last_run_at !== undefined ? { last_run_at } : {}),
    ...(last_started !== undefined ? { last_started } : {}),
  };
}

/**
 * Fold the pre-SQLite JSON file into the kv store exactly once per
 * process. Runs lazily on the first read rather than at boot so a
 * heartbeat-free deployment never pays for it. Gated + idempotent via
 * the module-level `imported` flag; the rename to `<file>.imported`
 * inside importLegacyJson stops it re-running across restarts.
 */
let imported = false;
function importLegacyStateOnce(): void {
  if (imported) return;
  imported = true;
  importLegacyJson({
    path: pathFiles.heartbeatState,
    category: "heartbeat",
    what: "heartbeat state",
    ingest: (data) => {
      const normalized = normalizeHeartbeatState(data);
      if (!normalized) return 0;
      kvSet(HEARTBEAT_STATE_KEY, normalized);
      return 1;
    },
  });
}

export function readHeartbeatState(): HeartbeatState | null {
  importLegacyStateOnce();
  return normalizeHeartbeatState(kvGet(HEARTBEAT_STATE_KEY));
}

export function writeHeartbeatState(state: HeartbeatState): void {
  // Re-derive last_run_at from last_run so the persisted ISO stamp can
  // never drift from the millisecond field; omit it on the sentinel
  // last_run === 0 (never-run) to match the pre-SQLite file format.
  const { last_run_at: _lastRunAt, ...rest } = state;
  const enriched: HeartbeatState = {
    ...rest,
    ...(state.last_run !== 0
      ? { last_run_at: new Date(state.last_run).toISOString() }
      : {}),
  };
  kvSet(HEARTBEAT_STATE_KEY, enriched);
}
