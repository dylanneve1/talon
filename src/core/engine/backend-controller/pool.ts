/**
 * Pool lifecycle + role bindings + observability: init/teardown, role
 * accessors, availability queries, the `/model` snapshot, and change
 * listeners.
 */

import type { Backend } from "../../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../../util/config.js";
import {
  listBackends,
  type BackendInitContext,
} from "../../agent-runtime/backend-registry.js";
import { log, logWarn } from "../../../util/log.js";
import { roleHolder } from "./holders.js";
import {
  pool,
  bindings,
  listeners,
  ctx,
  ensurePoolEntry,
  releaseHolderFromEntry,
  resolveRoleBackendId,
  hasBackendPool,
} from "./state.js";
import {
  ALL_ROLES,
  type BackendChangeListener,
  type BackendHolder,
  type BackendRole,
  type PoolSnapshot,
} from "./types.js";

export { hasBackendPool };

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
  initContext: BackendInitContext,
): Promise<void> {
  ctx.initCtx = initContext;
  ctx.poolConfig = config;
  const initialisedHolders: BackendHolder[] = [];
  try {
    for (const role of ALL_ROLES) {
      const holder = roleHolder(role);
      const id = resolveRoleBackendId(role, config);
      const entry = await ensurePoolEntry(id, config);
      entry.holders.add(holder);
      bindings.set(holder, id);
      initialisedHolders.push(holder);
    }
  } catch (err) {
    // Roll back partial init — release every holder that succeeded so
    // the pool isn't left holding orphaned instances.
    for (const holder of initialisedHolders) {
      const id = bindings.get(holder);
      bindings.delete(holder);
      if (id) {
        const entry = pool.get(id);
        if (entry) await releaseHolderFromEntry(entry, holder);
      }
    }
    ctx.initCtx = null;
    throw err;
  }
  const summary = ALL_ROLES.map(
    (r) => `${r}=${bindings.get(roleHolder(r))}`,
  ).join(" ");
  log("backend-controller", `Pool initialised — ${summary}`);
}

/** Backend instance for a role. Throws if the role isn't bound. */
export function getBackendForRole(role: BackendRole): Backend {
  const holder = roleHolder(role);
  const id = bindings.get(holder);
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
  const id = bindings.get(roleHolder(role));
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

/**
 * All registered backends, optionally filtered by `config.enabledBackends`.
 *
 * When `config.enabledBackends` is set, only ids on the whitelist are
 * returned (in the whitelist's order). When unset, every registered
 * backend is returned, sorted by id for deterministic output.
 */
export function listAvailableBackends(
  config?: TalonConfig,
): { id: string; label: string }[] {
  const all = listBackends().map((b) => ({ id: b.id, label: b.label }));
  const enabled = config?.enabledBackends;
  if (!enabled || enabled.length === 0) return all;
  const byId = new Map(all.map((b) => [b.id, b]));
  return enabled
    .map((id) => byId.get(id))
    .filter((b): b is { id: string; label: string } => Boolean(b));
}

/** Whether a backend id is registered and currently exposed by config. */
export function isBackendAvailable(id: string, config?: TalonConfig): boolean {
  return listAvailableBackends(config).some((b) => b.id === id);
}

/**
 * Available backends using the config captured at init — convenience for
 * runtime readers (e.g. the `list_backends` tool) that don't have config
 * plumbed through. Falls back to all registered backends pre-init.
 */
export function getAvailableBackends(): { id: string; label: string }[] {
  return listAvailableBackends(ctx.poolConfig ?? undefined);
}

/**
 * The live pooled `Backend` instance for an id, or `null` if it isn't currently
 * pooled. Unlike `getBackendForRole`/`getBackendForChat` this never initialises
 * on demand — it only returns backends already spun up (role backends + chat
 * overrides).
 */
export function getPooledBackend(id: string): Backend | null {
  return pool.get(id)?.backend ?? null;
}

/** Monotonic counter for synthetic transient holders. */
let transientHolderSeq = 0;

/**
 * Acquire a backend instance transiently — boots it on demand if it isn't
 * already pooled, pinned by a synthetic `read:N` holder so a concurrent rebind
 * can't tear it down mid-use. The caller MUST call the returned `release()`,
 * which drops the holder and cleans the instance up iff nothing else holds it
 * (so an already-active backend is left running).
 *
 * Used by read-only callers that need a non-current backend's catalog (e.g.
 * `list_models backend=<other>`) without permanently switching the chat to it.
 */
export async function acquireBackendInstance(
  id: string,
): Promise<{ backend: Backend; release: () => Promise<void> }> {
  if (!ctx.poolConfig) {
    throw new Error(
      "Backend pool not initialised — call initBackendPool first",
    );
  }
  const entry = await ensurePoolEntry(id, ctx.poolConfig);
  const holder = `read:${++transientHolderSeq}` as BackendHolder;
  entry.holders.add(holder);
  let released = false;
  return {
    backend: entry.backend,
    release: async () => {
      if (released) return;
      released = true;
      const e = pool.get(id);
      if (e) await releaseHolderFromEntry(e, holder);
    },
  };
}

/**
 * Validate a persisted model id against the backend that will serve
 * it. Resolves through the catalog's `resolveModelInfo` — exact
 * matches with `selectable !== false` are kept; everything else
 * falls back. Backends without a catalog return `true` (we can't
 * prove the value is stale, so we trust the chat-settings store).
 */
export async function isModelValidForBackend(
  backend: Backend,
  model: string,
): Promise<boolean> {
  const catalog = backend.models;
  if (!catalog) return true;
  const resolution = await catalog.resolveModelInfo(model);
  return resolution.kind === "exact" && resolution.model.selectable !== false;
}

/** Snapshot of the live pool + bindings for `/model` rendering. */
export function getPoolSnapshot(): PoolSnapshot {
  const instances = [...pool.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => {
      const holdersList = [...entry.holders].sort();
      const roles = holdersList
        .filter((h) => h.startsWith("role:"))
        .map((h) => h.slice(5) as BackendRole)
        .sort();
      const chats = holdersList
        .filter((h) => h.startsWith("chat:"))
        .map((h) => h.slice(5))
        .sort();
      return {
        id: entry.id,
        label: entry.label,
        holders: holdersList,
        roles,
        chats,
      };
    });
  const bindingsObj: Partial<Record<BackendRole, string>> = {};
  for (const role of ALL_ROLES) {
    const id = bindings.get(roleHolder(role));
    if (id) bindingsObj[role] = id;
  }
  return {
    instances,
    bindings: bindingsObj as Record<BackendRole, string>,
  };
}

/**
 * Register a backend-change listener.
 *
 * Listener receives the holder that changed (`role:chat`, `chat:1234`,
 * etc.), the new backend, and id/label. Fires AFTER the rebind is
 * committed and the new entry is in the pool, but BEFORE the previous
 * entry's cleanup runs (when applicable).
 */
export function onBackendChange(listener: BackendChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tear down the entire pool. Idempotent. */
export async function cleanupBackendPool(): Promise<void> {
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
  ctx.initCtx = null;
}

/** Test-only state reset. */
export function resetBackendPoolForTest(): void {
  pool.clear();
  bindings.clear();
  ctx.initCtx = null;
  ctx.poolConfig = null;
}

/** Test-only: drop all listeners. */
export function clearBackendChangeListenersForTest(): void {
  listeners.clear();
}
