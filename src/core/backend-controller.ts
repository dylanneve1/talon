/**
 * Backend controller — refcounted pool of `QueryBackend` instances
 * with per-role bindings. The chat, heartbeat, and dream subsystems
 * each bind their own backend; instances are shared when multiple
 * roles point at the same backend id.
 *
 * Why a pool, not a single active backend
 * ───────────────────────────────────────
 *
 * Different roles have different cost/latency profiles. Typical setup
 * post-Anthropic-metering: free-tier OpenRouter via OpenAI Agents for
 * heartbeats, paid Claude Sonnet for chat, Codex / gpt-5.5 for dream.
 * A single-active model can't express that — every role gets the
 * same backend. The pool lets each role bind independently while
 * deduplicating instances when ids overlap.
 *
 * Lifecycle
 * ─────────
 *
 *   1. Bootstrap calls `initBackendPool(config, ctx)` once at startup.
 *      It binds the three default roles (chat / heartbeat / dream)
 *      using `config.backend`, `config.heartbeatBackend ?? backend`,
 *      `config.dreamBackend ?? backend`. Instances with the same id
 *      are reused (refcount goes up).
 *   2. Hot-path consumers read their role's backend through
 *      `getBackendForRole(role)` each call — no cached reference, so
 *      rebinds propagate without restart.
 *   3. `rebindRole(role, newId, config)` swaps a single role's
 *      binding. If the new id is already pooled (because another
 *      role uses it), the existing instance is reused. The previous
 *      instance's refcount drops; if it hits zero, cleanup fires.
 *      Init failures leave the previous binding in place.
 *   4. Listeners notified after rebind — gateway etc. refresh their
 *      cached `backend` field.
 *
 * Legacy aliases (`initBackendController`, `getActiveBackend`,
 * `switchBackend`, etc.) are kept and route to the chat role for
 * backward compatibility with consumers that haven't been ported.
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

/** Roles that can bind to a backend instance. */
export type BackendRole = "chat" | "heartbeat" | "dream";

const ALL_ROLES: readonly BackendRole[] = ["chat", "heartbeat", "dream"];

/** Pool entry — one initialised backend with the roles currently using it. */
interface PoolEntry {
  id: string;
  label: string;
  backend: QueryBackend;
  cleanup?: () => Promise<void> | void;
  roles: Set<BackendRole>;
}

export interface RebindResult {
  ok: boolean;
  /** Backend id the role was bound to before the rebind. */
  from?: string;
  /** Backend id the role is now bound to. */
  to?: string;
  /** Whether the previous instance was kept alive (still bound to another role). */
  previousReused?: boolean;
  /** Whether the new binding reuses an existing pool instance. */
  newReused?: boolean;
  /** Human-readable error on failure. */
  error?: string;
}

/** Snapshot of the pool for observability / `/backend` rendering. */
export interface PoolSnapshot {
  /** Active pool entries, sorted by id. */
  instances: Array<{
    id: string;
    label: string;
    roles: BackendRole[];
  }>;
  /** Current role bindings (always all three roles once initialised). */
  bindings: Record<BackendRole, string>;
}

/** Notified after a successful rebind. */
type BackendChangeListener = (
  role: BackendRole,
  backend: QueryBackend,
  ctx: { id: string; label: string },
) => void;

// ── State ───────────────────────────────────────────────────────────────────

/** id → entry. */
const pool = new Map<string, PoolEntry>();
/** role → backend id (only populated for roles that have been bound). */
const bindings = new Map<BackendRole, string>();
/** Captured at first init so rebind doesn't need ctx plumbed through. */
let initCtx: BackendInitContext | null = null;

const listeners = new Set<BackendChangeListener>();

// ── Internal helpers ────────────────────────────────────────────────────────

/** Look up or initialise a pool entry for a backend id. */
async function ensurePoolEntry(
  id: string,
  config: TalonConfig,
): Promise<PoolEntry> {
  const existing = pool.get(id);
  if (existing) return existing;

  const factory = getBackend(id);
  if (!factory) {
    const known = listBackends()
      .map((b) => `"${b.id}"`)
      .join(", ");
    throw new Error(`Unknown backend "${id}" — known: ${known}`);
  }
  if (!initCtx) {
    throw new Error(
      "Backend pool not initialised — call initBackendPool first",
    );
  }
  const instance = await factory.init(config, initCtx);
  const entry: PoolEntry = {
    id: factory.id,
    label: factory.label,
    backend: instance.backend,
    cleanup: instance.cleanup,
    roles: new Set(),
  };
  pool.set(factory.id, entry);
  log("backend-controller", `Pool init: ${factory.label} (${factory.id})`);
  return entry;
}

/** Drop a role from an entry; clean the entry up if its refcount hits zero. */
async function releaseEntry(entry: PoolEntry, role: BackendRole): Promise<void> {
  entry.roles.delete(role);
  if (entry.roles.size > 0) {
    log(
      "backend-controller",
      `Released role ${role} from ${entry.label} (still bound by: ${[...entry.roles].join(", ")})`,
    );
    return;
  }
  // Last role releasing — tear down.
  pool.delete(entry.id);
  if (entry.cleanup) {
    try {
      await entry.cleanup();
      log("backend-controller", `Pool cleanup: ${entry.label} (${entry.id})`);
    } catch (err) {
      logWarn(
        "backend-controller",
        `Cleanup of ${entry.label} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  } else {
    log("backend-controller", `Pool cleanup: ${entry.label} (no cleanup hook)`);
  }
}

function notifyListeners(
  role: BackendRole,
  backend: QueryBackend,
  ctx: { id: string; label: string },
): void {
  for (const listener of listeners) {
    try {
      listener(role, backend, ctx);
    } catch (err) {
      logWarn(
        "backend-controller",
        `Backend-change listener threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function resolveRoleBackendId(role: BackendRole, config: TalonConfig): string {
  switch (role) {
    case "chat":
      return config.backend;
    case "heartbeat":
      return config.heartbeatBackend ?? config.backend;
    case "dream":
      return config.dreamBackend ?? config.backend;
  }
}

// ── Public API: pool / multi-role ───────────────────────────────────────────

/**
 * Initialise the backend pool with bindings for every role.
 *
 * Reads `config.backend` (chat), `config.heartbeatBackend` (heartbeat,
 * falls back to chat), `config.dreamBackend` (dream, falls back to
 * chat). Identical ids share a pool instance — Talon does NOT spin up
 * two Claude SDK runtimes just because chat and heartbeat both want
 * Claude.
 *
 * If any role's init fails, previously-initialised roles are torn
 * down before the throw bubbles up — so a partial-init state never
 * leaks past bootstrap.
 */
export async function initBackendPool(
  config: TalonConfig,
  ctx: BackendInitContext,
): Promise<void> {
  initCtx = ctx;
  const initialised: BackendRole[] = [];
  try {
    for (const role of ALL_ROLES) {
      const id = resolveRoleBackendId(role, config);
      const entry = await ensurePoolEntry(id, config);
      entry.roles.add(role);
      bindings.set(role, id);
      initialised.push(role);
    }
  } catch (err) {
    // Roll back partial init — release every role that succeeded so
    // the pool isn't left holding orphaned instances.
    for (const role of initialised) {
      const id = bindings.get(role);
      bindings.delete(role);
      if (id) {
        const entry = pool.get(id);
        if (entry) await releaseEntry(entry, role);
      }
    }
    initCtx = null;
    throw err;
  }
  const summary = ALL_ROLES.map((r) => `${r}=${bindings.get(r)}`).join(" ");
  log("backend-controller", `Pool initialised — ${summary}`);
}

/** Has the pool been initialised? */
export function hasBackendPool(): boolean {
  return bindings.size > 0;
}

/** Backend instance for a role. Throws if the role isn't bound. */
export function getBackendForRole(role: BackendRole): QueryBackend {
  const id = bindings.get(role);
  if (!id) {
    throw new Error(
      `Backend role "${role}" not bound — initialise the pool or rebind first`,
    );
  }
  const entry = pool.get(id);
  if (!entry) {
    throw new Error(
      `Backend role "${role}" bound to "${id}" but pool entry missing`,
    );
  }
  return entry.backend;
}

/** Backend id bound to a role. Throws if the role isn't bound. */
export function getBackendIdForRole(role: BackendRole): string {
  const id = bindings.get(role);
  if (!id) {
    throw new Error(`Backend role "${role}" not bound`);
  }
  return id;
}

/** Display label for the role's bound backend. */
export function getBackendLabelForRole(role: BackendRole): string {
  const id = getBackendIdForRole(role);
  const entry = pool.get(id);
  if (!entry) {
    throw new Error(`Pool entry for "${id}" missing`);
  }
  return entry.label;
}

/** All registered backends (whether currently pooled or not). */
export function listAvailableBackends(): { id: string; label: string }[] {
  return listBackends().map((b) => ({ id: b.id, label: b.label }));
}

/** Snapshot of the live pool + bindings for `/backend` rendering. */
export function getPoolSnapshot(): PoolSnapshot {
  const instances = [...pool.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      roles: [...entry.roles].sort(),
    }));
  const bindingsObj: Partial<Record<BackendRole, string>> = {};
  for (const role of ALL_ROLES) {
    const id = bindings.get(role);
    if (id) bindingsObj[role] = id;
  }
  return {
    instances,
    bindings: bindingsObj as Record<BackendRole, string>,
  };
}

/**
 * Rebind one role to a different backend id.
 *
 * Pool semantics:
 *   - If the target id is already pooled (another role uses it), the
 *     existing instance is reused — no double init.
 *   - The previous binding's instance loses a refcount; cleanup fires
 *     only if no other role still references it.
 *   - Failed init leaves the previous binding in place.
 */
export async function rebindRole(
  role: BackendRole,
  newId: string,
  config: TalonConfig,
): Promise<RebindResult> {
  if (!initCtx) {
    return { ok: false, error: "Backend pool not initialised" };
  }
  const currentId = bindings.get(role);
  if (currentId === newId) {
    return { ok: false, error: `Role "${role}" already bound to "${newId}"` };
  }

  const factory = getBackend(newId);
  if (!factory) {
    const known = listBackends()
      .map((b) => `"${b.id}"`)
      .join(", ");
    return { ok: false, error: `Unknown backend "${newId}" — known: ${known}` };
  }

  const newReused = pool.has(newId);
  let newEntry: PoolEntry;
  try {
    newEntry = await ensurePoolEntry(newId, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      "backend-controller",
      `rebindRole(${role}, ${newId}) init failed: ${msg} — binding unchanged`,
    );
    // Wrap with the factory label when we have it so callers see a
    // contextual error rather than the raw factory-level message.
    const wrapped = `Failed to init ${factory.label}: ${msg}`;
    return { ok: false, error: wrapped };
  }
  newEntry.roles.add(role);
  bindings.set(role, newId);

  // Release the previous binding (no-op if there was none).
  let previousReused = false;
  if (currentId) {
    const oldEntry = pool.get(currentId);
    if (oldEntry) {
      // If the entry still has other roles, cleanup won't run.
      previousReused = oldEntry.roles.size > 1;
      await releaseEntry(oldEntry, role);
    }
  }

  log(
    "backend-controller",
    `Rebound ${role}: ${currentId ?? "(unbound)"} → ${newId}` +
      (newReused ? " (reused pool instance)" : ""),
  );
  notifyListeners(role, newEntry.backend, { id: newId, label: newEntry.label });

  return {
    ok: true,
    from: currentId,
    to: newId,
    previousReused,
    newReused,
  };
}

/**
 * Register a backend-change listener.
 *
 * Listener receives the role that changed, the new backend, and id/
 * label. Fires AFTER the rebind is committed and the new entry is
 * in the pool, but BEFORE the previous entry's cleanup runs (when
 * applicable).
 */
export function onBackendChange(listener: BackendChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tear down the entire pool. Idempotent. */
export async function cleanupBackendPool(): Promise<void> {
  // Drop bindings first so role accessors throw rather than returning
  // half-torn-down instances during cleanup.
  const entries = [...pool.values()];
  pool.clear();
  bindings.clear();
  for (const entry of entries) {
    if (entry.cleanup) {
      try {
        await entry.cleanup();
      } catch (err) {
        logWarn(
          "backend-controller",
          `Pool shutdown cleanup of ${entry.label} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
  initCtx = null;
}

/** Test-only state reset. */
export function resetBackendPoolForTest(): void {
  pool.clear();
  bindings.clear();
  initCtx = null;
}

/** Test-only: drop all listeners. */
export function clearBackendChangeListenersForTest(): void {
  listeners.clear();
}

// ── Legacy single-active aliases (chat role) ────────────────────────────────
//
// Preserved so consumers that pre-date the pool refactor (and any
// integration tests we haven't ported yet) keep working. They all
// route to the chat role — the canonical "default" backend.

/**
 * Initialise the controller with a single backend bound to the chat
 * role. Convenience for tests and any legacy bootstrap path that
 * doesn't yet provide `heartbeatBackend` / `dreamBackend`. Production
 * code should use `initBackendPool` instead.
 */
export async function initBackendController(
  id: string,
  config: TalonConfig,
  ctx: BackendInitContext,
): Promise<QueryBackend> {
  initCtx = ctx;
  const entry = await ensurePoolEntry(id, config);
  entry.roles.add("chat");
  bindings.set("chat", id);
  log("backend-controller", `Active backend (chat): ${entry.label} (${id})`);
  return entry.backend;
}

/** Equivalent to `getBackendForRole("chat")`. Legacy alias. */
export function getActiveBackend(): QueryBackend {
  if (!bindings.has("chat")) {
    throw new Error(
      "Backend controller not initialised — call initBackendController first",
    );
  }
  return getBackendForRole("chat");
}

/** Whether the chat role has been bound. Legacy alias. */
export function hasActiveBackend(): boolean {
  return bindings.has("chat");
}

/** Like `getActiveBackend` but returns `null` instead of throwing. */
export function getActiveBackendOrNull(): QueryBackend | null {
  if (!bindings.has("chat")) return null;
  try {
    return getBackendForRole("chat");
  } catch {
    return null;
  }
}

/** Id of the chat-role backend. Legacy alias. */
export function getActiveBackendId(): string {
  if (!bindings.has("chat")) {
    throw new Error("Backend controller not initialised");
  }
  return getBackendIdForRole("chat");
}

/** Label of the chat-role backend. Legacy alias. */
export function getActiveBackendLabel(): string {
  if (!bindings.has("chat")) {
    throw new Error("Backend controller not initialised");
  }
  return getBackendLabelForRole("chat");
}

/** Rebind the chat role. Legacy alias for `rebindRole("chat", id, config)`. */
export async function switchBackend(
  id: string,
  config: TalonConfig,
): Promise<RebindResult> {
  if (!bindings.has("chat")) {
    return { ok: false, error: "Backend controller not initialised" };
  }
  const current = bindings.get("chat");
  if (current === id) {
    const entry = pool.get(current);
    return {
      ok: false,
      error: `Already on ${entry?.label ?? current}`,
    };
  }
  return rebindRole("chat", id, config);
}

/** Tear down the entire pool. Legacy alias for `cleanupBackendPool`. */
export async function cleanupBackendController(): Promise<void> {
  await cleanupBackendPool();
}

/** Reset state. Test-only. Legacy alias. */
export function resetBackendControllerForTest(): void {
  resetBackendPoolForTest();
}
