/**
 * Backend controller — owns the currently-active backend and brokers
 * hot-swaps between registered backends at runtime.
 *
 * Before this module, the bootstrap layer picked exactly one backend
 * from `config.backend`, instantiated it, and threaded the resulting
 * `QueryBackend` directly into the dispatcher, dream, and heartbeat
 * subsystems. Switching backends required restarting Talon.
 *
 * The controller introduces a single point of truth — every consumer
 * (dispatcher / dream / heartbeat / status reporters / model picker)
 * now reads the active backend through a getter rather than holding
 * a reference. Switching backends becomes a four-step operation:
 *
 *   1. Look up the new factory in the registry.
 *   2. Call `factory.init(config, ctx)` to construct the replacement.
 *   3. Atomically swap the active pointer so subsequent reads route
 *      to the new backend.
 *   4. Best-effort cleanup of the previous backend's resources
 *      (HTTP servers, MCP subprocesses, per-chat caches).
 *
 * Init-before-cleanup is deliberate: if the new backend fails to
 * spin up, we keep the previous one running rather than leaving
 * Talon in a brick state.
 */

import type { QueryBackend } from "./types.js";
import type { TalonConfig } from "../util/config.js";
import {
  getBackend,
  listBackends,
  type BackendInitContext,
} from "../backend/registry.js";
import { log, logWarn } from "../util/log.js";

// ── Types ───────────────────────────────────────────────────────────────────

interface ActiveBackend {
  id: string;
  label: string;
  backend: QueryBackend;
  cleanup?: () => Promise<void> | void;
}

export interface SwitchResult {
  ok: boolean;
  /** Previous backend id (present on success). */
  from?: string;
  /** New backend id (present on success). */
  to?: string;
  /** Human-readable error message (present on failure). */
  error?: string;
}

// ── State ───────────────────────────────────────────────────────────────────

let active: ActiveBackend | null = null;
let initCtx: BackendInitContext | null = null;

/**
 * Listeners notified on every successful backend swap. Consumers that
 * cache the backend reference (`Gateway.backend`, integration tests,
 * external observability hooks) register here at init time and update
 * their snapshot in the callback.
 *
 * Hot-path consumers (dispatcher / dream / heartbeat) don't need to
 * register — they read the active backend through `getActiveBackend`
 * each call.
 */
type BackendChangeListener = (
  backend: QueryBackend,
  ctx: { id: string; label: string },
) => void;
const listeners = new Set<BackendChangeListener>();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialise the controller with an initial backend.
 *
 * Called exactly once at bootstrap. The supplied `ctx` is captured so
 * subsequent `switchBackend()` calls can pass it to the new factory's
 * `init` step without the caller having to plumb it through.
 *
 * Throws if the requested backend id isn't registered or if init fails.
 */
export async function initBackendController(
  id: string,
  config: TalonConfig,
  ctx: BackendInitContext,
): Promise<QueryBackend> {
  const factory = getBackend(id);
  if (!factory) {
    const known = listBackends()
      .map((b) => `"${b.id}"`)
      .join(", ");
    throw new Error(
      `Unknown backend "${id}" — known: ${known}. Check config.backend in talon.json.`,
    );
  }
  const instance = await factory.init(config, ctx);
  active = {
    id: factory.id,
    label: factory.label,
    backend: instance.backend,
    cleanup: instance.cleanup,
  };
  initCtx = ctx;
  log("backend-controller", `Active backend: ${factory.label} (${factory.id})`);
  return instance.backend;
}

/**
 * Read the currently-active backend.
 *
 * Throws if the controller hasn't been initialised — callers should
 * pass `getActiveBackend` itself (not its return value) into consumers
 * that need to survive hot-swaps.
 */
export function getActiveBackend(): QueryBackend {
  if (!active) {
    throw new Error(
      "Backend controller not initialised — call initBackendController first",
    );
  }
  return active.backend;
}

/** Whether the controller has been initialised. */
export function hasActiveBackend(): boolean {
  return active !== null;
}

/**
 * Like `getActiveBackend` but returns `null` instead of throwing when
 * the controller isn't initialised yet. Suitable for callers in hot
 * paths (`/model` rendering, gateway dispatch) that previously held a
 * nullable backend reference.
 */
export function getActiveBackendOrNull(): QueryBackend | null {
  return active?.backend ?? null;
}

/** Stable id of the currently-active backend (e.g. `"claude-sdk"`). */
export function getActiveBackendId(): string {
  if (!active) {
    throw new Error("Backend controller not initialised");
  }
  return active.id;
}

/** Display label of the currently-active backend (e.g. `"Claude SDK"`). */
export function getActiveBackendLabel(): string {
  if (!active) {
    throw new Error("Backend controller not initialised");
  }
  return active.label;
}

/**
 * Hot-swap to a different registered backend.
 *
 * Lifecycle:
 *   1. Reject same-id swap (cheap no-op the caller can spot).
 *   2. Reject unknown ids with a helpful list of registered backends.
 *   3. Init the replacement BEFORE tearing down the incumbent so that
 *      init failures leave the previous backend in place.
 *   4. Atomically swap `active`, then best-effort clean up the old
 *      backend. Cleanup errors are logged but don't fail the swap —
 *      the new backend is already serving requests.
 *
 * Callers that need to reset chat sessions (typical) should do so
 * after this resolves with `ok: true`.
 */
export async function switchBackend(
  id: string,
  config: TalonConfig,
): Promise<SwitchResult> {
  if (!active || !initCtx) {
    return { ok: false, error: "Backend controller not initialised" };
  }
  if (id === active.id) {
    return { ok: false, error: `Already on ${active.label}` };
  }
  const factory = getBackend(id);
  if (!factory) {
    const known = listBackends()
      .map((b) => `"${b.id}"`)
      .join(", ");
    return { ok: false, error: `Unknown backend "${id}" — known: ${known}` };
  }

  const prevId = active.id;
  const prevLabel = active.label;
  const prevCleanup = active.cleanup;

  log("backend-controller", `Switching backend: ${prevId} → ${factory.id}`);

  let instance;
  try {
    instance = await factory.init(config, initCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      "backend-controller",
      `Failed to init ${factory.label}: ${msg} — keeping ${prevLabel} active`,
    );
    return { ok: false, error: `Failed to init ${factory.label}: ${msg}` };
  }

  // Atomically swap before cleanup so subsequent reads route to the
  // new backend even if cleanup hangs.
  active = {
    id: factory.id,
    label: factory.label,
    backend: instance.backend,
    cleanup: instance.cleanup,
  };

  // Notify cached-reference holders (gateway, etc) before cleanup so
  // they don't briefly point at a torn-down backend.
  for (const listener of listeners) {
    try {
      listener(instance.backend, { id: factory.id, label: factory.label });
    } catch (err) {
      logWarn(
        "backend-controller",
        `Backend-change listener threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (prevCleanup) {
    try {
      await prevCleanup();
      log("backend-controller", `Cleaned up previous backend: ${prevLabel}`);
    } catch (err) {
      logWarn(
        "backend-controller",
        `Cleanup of ${prevLabel} failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return { ok: true, from: prevId, to: factory.id };
}

/**
 * List the ids of all registered backends. Useful for `/backend` slash
 * commands, status reporters, and config validators.
 */
export function listAvailableBackends(): { id: string; label: string }[] {
  return listBackends().map((b) => ({ id: b.id, label: b.label }));
}

/**
 * Register a backend-change listener. Returns an unsubscribe function.
 *
 * Listeners fire AFTER the new backend is fully initialised and the
 * active pointer has been swapped, but BEFORE the previous backend's
 * cleanup runs — consumers should be ready to handle queries to the
 * new backend the moment they're notified.
 */
export function onBackendChange(listener: BackendChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: drop all listeners. */
export function clearBackendChangeListenersForTest(): void {
  listeners.clear();
}

/**
 * Tear down the active backend. Called on Talon shutdown. Idempotent.
 */
export async function cleanupBackendController(): Promise<void> {
  if (active?.cleanup) {
    try {
      await active.cleanup();
    } catch (err) {
      logWarn(
        "backend-controller",
        `Shutdown cleanup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  active = null;
  initCtx = null;
}

/**
 * Reset controller state. Test-only — production code should never
 * call this directly.
 */
export function resetBackendControllerForTest(): void {
  active = null;
  initCtx = null;
}
