/**
 * Backend controller — refcounted pool of `Backend` instances
 * keyed by **holder**. A holder is any string the rest of Talon uses
 * to claim a backend reference: `role:chat`, `role:heartbeat`,
 * `role:dream`, or `chat:<chatId>` for per-chat overrides.
 *
 * Why a pool, not a single active backend
 * ───────────────────────────────────────
 *
 * Different roles, and different chats, have different cost/latency/
 * quality needs. Typical post-Anthropic-metering setup: chat default
 * on free-tier OpenAI Agents, heartbeats on Claude Sonnet, dream
 * shared with chat — plus Pandario stays on Claude while DMs use the
 * cheap default. A single-active model can't express that. The pool
 * lets each holder bind independently while deduplicating instances
 * when ids overlap.
 *
 * Lifecycle
 * ─────────
 *
 *   1. `initBackendPool(config, ctx)` is called once at bootstrap.
 *      It binds the three default holders (`role:chat`,
 *      `role:heartbeat`, `role:dream`) using `config.backend`,
 *      `config.heartbeatBackend ?? backend`, `config.dreamBackend ??
 *       backend`. Identical ids share a pool entry.
 *   2. Hot-path consumers (dispatcher / dream / heartbeat) read their
 *      holder's backend through the role / chat accessors each call —
 *      so rebinds propagate without restart.
 *   3. `rebindHolder(holder, newId, config)` swaps a single holder.
 *      If `newId` is already pooled (another holder uses it), the
 *      existing instance is reused. The previous binding's refcount
 *      drops; cleanup fires only when no other holder still
 *      references the entry.
 *   4. Per-chat overrides land via `rebindChat(chatId, newId, config)`
 *      (acquiring) and `releaseChat(chatId)` (reverting to default).
 *   5. Failed init keeps the previous binding intact.
 *
 * Legacy single-active aliases (`initBackendController`,
 * `getActiveBackend`, `switchBackend`, etc.) are kept and route to
 * the chat role for backward compatibility with consumers that
 * haven't been ported.
 */

import type { Backend } from "../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../util/config.js";
import {
  getBackend,
  listBackends,
  type BackendInitContext,
} from "../../backend/registry.js";
import { log, logWarn } from "../../util/log.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Roles that map to global holders. */
export type BackendRole = "chat" | "heartbeat" | "dream";

const ALL_ROLES: readonly BackendRole[] = ["chat", "heartbeat", "dream"];

/** Holder identifier — opaque string. Use `roleHolder()` / `chatHolder()`. */
export type BackendHolder = string;

/** Build the holder string for a role. */
export function roleHolder(role: BackendRole): BackendHolder {
  return `role:${role}`;
}

/** Build the holder string for a per-chat override. */
export function chatHolder(chatId: string): BackendHolder {
  return `chat:${chatId}`;
}

interface PoolEntry {
  id: string;
  label: string;
  backend: Backend;
  cleanup?: () => Promise<void> | void;
  holders: Set<BackendHolder>;
}

export interface RebindResult {
  ok: boolean;
  /** Backend id the holder was bound to before the rebind (omitted when none). */
  from?: string;
  /** Backend id the holder is now bound to. */
  to?: string;
  /** Whether the previous instance stays alive (still bound elsewhere). */
  previousReused?: boolean;
  /** Whether the new binding reuses an existing pool instance. */
  newReused?: boolean;
  /** Human-readable error on failure. */
  error?: string;
}

/** Snapshot of the pool for observability / `/model` rendering. */
export interface PoolSnapshot {
  /** Active pool entries, sorted by id, with the holders pinning them. */
  instances: Array<{
    id: string;
    label: string;
    /** Free-form holder strings — useful for diagnostics. */
    holders: BackendHolder[];
    /** Role-only subset, kept sorted, for the common case. */
    roles: BackendRole[];
    /** Per-chat overrides (chat ids only). */
    chats: string[];
  }>;
  /** Current role bindings (always all three roles once initialised). */
  bindings: Record<BackendRole, string>;
}

/** Notified after a successful rebind. */
type BackendChangeListener = (
  holder: BackendHolder,
  backend: Backend,
  ctx: { id: string; label: string },
) => void;

// ── State ───────────────────────────────────────────────────────────────────

/** id → entry. */
const pool = new Map<string, PoolEntry>();
/** holder → backend id (only present for holders currently bound). */
const bindings = new Map<BackendHolder, string>();
/** Captured at first init so subsequent calls don't need ctx plumbed through. */
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
    holders: new Set(),
  };
  pool.set(factory.id, entry);
  log("backend-controller", `Pool init: ${factory.label} (${factory.id})`);
  return entry;
}

/** Drop a holder from an entry; clean up the entry if its refcount hits zero. */
async function releaseHolderFromEntry(
  entry: PoolEntry,
  holder: BackendHolder,
): Promise<void> {
  entry.holders.delete(holder);
  if (entry.holders.size > 0) {
    log(
      "backend-controller",
      `Released ${holder} from ${entry.label} (still held by: ${[...entry.holders].join(", ")})`,
    );
    return;
  }
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
  holder: BackendHolder,
  backend: Backend,
  ctx: { id: string; label: string },
): void {
  for (const listener of listeners) {
    try {
      listener(holder, backend, ctx);
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

// ── Public API: pool / role bindings ────────────────────────────────────────

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
    initCtx = null;
    throw err;
  }
  const summary = ALL_ROLES.map(
    (r) => `${r}=${bindings.get(roleHolder(r))}`,
  ).join(" ");
  log("backend-controller", `Pool initialised — ${summary}`);
}

/** Has the pool been initialised? */
export function hasBackendPool(): boolean {
  return bindings.has(roleHolder("chat"));
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
 * Rebind any holder to a different backend id.
 *
 * Pool semantics:
 *   - If the target id is already pooled (another holder uses it),
 *     the existing instance is reused — no double init.
 *   - The previous binding's instance loses a refcount; cleanup fires
 *     only if no other holder still references it.
 *   - Failed init leaves the previous binding in place.
 *
 * Use `rebindRole` / `rebindChat` for typed wrappers.
 */
export async function rebindHolder(
  holder: BackendHolder,
  newId: string,
  config: TalonConfig,
): Promise<RebindResult> {
  if (!initCtx) {
    return { ok: false, error: "Backend pool not initialised" };
  }
  const currentId = bindings.get(holder);
  if (currentId === newId) {
    return {
      ok: false,
      error: `Holder "${holder}" already bound to "${newId}"`,
    };
  }

  const factory = getBackend(newId);
  if (!factory) {
    const known = listBackends()
      .map((b) => `"${b.id}"`)
      .join(", ");
    return {
      ok: false,
      error: `Unknown backend "${newId}" — known: ${known}`,
    };
  }

  const newReused = pool.has(newId);
  let newEntry: PoolEntry;
  try {
    newEntry = await ensurePoolEntry(newId, config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarn(
      "backend-controller",
      `rebindHolder(${holder}, ${newId}) init failed: ${msg} — binding unchanged`,
    );
    return { ok: false, error: `Failed to init ${factory.label}: ${msg}` };
  }
  newEntry.holders.add(holder);
  bindings.set(holder, newId);

  let previousReused = false;
  if (currentId) {
    const oldEntry = pool.get(currentId);
    if (oldEntry) {
      previousReused = oldEntry.holders.size > 1;
      await releaseHolderFromEntry(oldEntry, holder);
    }
  }

  log(
    "backend-controller",
    `Rebound ${holder}: ${currentId ?? "(unbound)"} → ${newId}` +
      (newReused ? " (reused pool instance)" : ""),
  );
  notifyListeners(holder, newEntry.backend, {
    id: newId,
    label: newEntry.label,
  });

  return {
    ok: true,
    from: currentId,
    to: newId,
    previousReused,
    newReused,
  };
}

/**
 * Release a holder. If the entry it was holding has no other holders,
 * the entry is cleaned up.
 *
 * No-op when the holder isn't bound — useful for "clear my override"
 * flows that don't want to care whether the override was ever set.
 */
export async function releaseHolder(holder: BackendHolder): Promise<void> {
  const id = bindings.get(holder);
  if (!id) return;
  bindings.delete(holder);
  const entry = pool.get(id);
  if (entry) await releaseHolderFromEntry(entry, holder);
}

/** Rebind a role. Convenience wrapper over `rebindHolder`. */
export function rebindRole(
  role: BackendRole,
  newId: string,
  config: TalonConfig,
): Promise<RebindResult> {
  return rebindHolder(roleHolder(role), newId, config);
}

/**
 * Rebind a per-chat override.
 *
 * Pool refcounts the new backend in addition to whatever the role
 * holders already pin. Releasing the chat (`releaseChat`) reverts the
 * chat to whichever backend the chat-role is bound to.
 */
export function rebindChat(
  chatId: string,
  newId: string,
  config: TalonConfig,
): Promise<RebindResult> {
  return rebindHolder(chatHolder(chatId), newId, config);
}

/** Release a per-chat override — the chat reverts to the global default. */
export function releaseChat(chatId: string): Promise<void> {
  return releaseHolder(chatHolder(chatId));
}

/**
 * Resolve the backend a chat should use right now.
 *
 * If the chat has an override pooled, return that backend; otherwise
 * fall back to the global chat-role backend.
 */
export function getBackendForChat(chatId: string): Backend {
  const overrideId = bindings.get(chatHolder(chatId));
  if (overrideId) {
    const entry = pool.get(overrideId);
    if (entry) return entry.backend;
  }
  return getBackendForRole("chat");
}

/** Backend id the chat would resolve to (override → role default). */
export function getBackendIdForChat(chatId: string): string {
  return bindings.get(chatHolder(chatId)) ?? getBackendIdForRole("chat");
}

/** Whether this chat has an override pinning a non-default backend. */
export function hasChatBackendOverride(chatId: string): boolean {
  return bindings.has(chatHolder(chatId));
}

/**
 * Safe variant of `getBackendForChat` that never throws — returns
 * the per-chat / role:chat backend when the pool is initialised, or
 * `fallback` (typically `gateway?.backend`) when it isn't.
 *
 * The pool is always initialised in production at bootstrap; this
 * helper exists so unit tests and legacy code paths that wire the
 * frontend before the pool can degrade gracefully instead of
 * throwing on every `/model` command. Frontends should call this
 * everywhere they previously read `gateway?.backend` for /model,
 * /status, and warmSession — otherwise per-chat backend overrides
 * silently lose effect.
 */
export function resolveChatBackend(
  chatId: string,
  fallback?: Backend | null,
): Backend | null {
  if (hasBackendPool()) {
    try {
      return getBackendForChat(chatId);
    } catch {
      // Pool initialised but the chat-role binding is somehow missing —
      // shouldn't happen in practice, but degrade to fallback rather
      // than crash a /model render.
    }
  }
  return fallback ?? null;
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
// Preserved so consumers that pre-date the pool refactor stay green.
// All route to the chat role — the canonical "default" backend.

/**
 * Initialise the controller with a single backend bound to the chat
 * role. Convenience for tests; production should use `initBackendPool`.
 */
export async function initBackendController(
  id: string,
  config: TalonConfig,
  ctx: BackendInitContext,
): Promise<Backend> {
  initCtx = ctx;
  const entry = await ensurePoolEntry(id, config);
  const holder = roleHolder("chat");
  entry.holders.add(holder);
  bindings.set(holder, id);
  log("backend-controller", `Active backend (chat): ${entry.label} (${id})`);
  return entry.backend;
}

/** Equivalent to `getBackendForRole("chat")`. Legacy alias. */
export function getActiveBackend(): Backend {
  if (!bindings.has(roleHolder("chat"))) {
    throw new Error(
      "Backend controller not initialised — call initBackendController first",
    );
  }
  return getBackendForRole("chat");
}

/** Whether the chat role has been bound. Legacy alias. */
export function hasActiveBackend(): boolean {
  return bindings.has(roleHolder("chat"));
}

/** Like `getActiveBackend` but returns `null` instead of throwing. */
export function getActiveBackendOrNull(): Backend | null {
  if (!bindings.has(roleHolder("chat"))) return null;
  try {
    return getBackendForRole("chat");
  } catch {
    return null;
  }
}

/** Id of the chat-role backend. Legacy alias. */
export function getActiveBackendId(): string {
  if (!bindings.has(roleHolder("chat"))) {
    throw new Error("Backend controller not initialised");
  }
  return getBackendIdForRole("chat");
}

/** Label of the chat-role backend. Legacy alias. */
export function getActiveBackendLabel(): string {
  if (!bindings.has(roleHolder("chat"))) {
    throw new Error("Backend controller not initialised");
  }
  return getBackendLabelForRole("chat");
}

/** Rebind the chat role. Legacy alias for `rebindRole("chat", id, config)`. */
export async function switchBackend(
  id: string,
  config: TalonConfig,
): Promise<RebindResult> {
  if (!bindings.has(roleHolder("chat"))) {
    return { ok: false, error: "Backend controller not initialised" };
  }
  const current = bindings.get(roleHolder("chat"));
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
