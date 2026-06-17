/**
 * Backend-pool shared state + internal helpers.
 *
 * All pool modules import the SAME Map/Set instances and the SAME `ctx`
 * holder from here, so refcounting and rebinds stay coherent across files.
 * `initCtx`/`poolConfig` are reassignable, so they live on the mutable `ctx`
 * object rather than as module-level `let`s (which can't be reassigned from
 * another module).
 */

import type { Backend } from "../../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../../util/config.js";
import {
  getBackend,
  listBackends,
  type BackendInitContext,
} from "../../agent-runtime/backend-registry.js";
import { log, logWarn } from "../../../util/log.js";
import { roleHolder } from "./holders.js";
import type { BackendChangeListener, BackendHolder } from "./types.js";

export interface PoolEntry {
  id: string;
  label: string;
  backend: Backend;
  cleanup?: () => Promise<void> | void;
  holders: Set<BackendHolder>;
}

/** id → entry. */
export const pool = new Map<string, PoolEntry>();
/** holder → backend id (only present for holders currently bound). */
export const bindings = new Map<BackendHolder, string>();

export const listeners = new Set<BackendChangeListener>();

/**
 * Reassignable init context, captured at first init so subsequent calls don't
 * need ctx/config plumbed through. On a holder object so other modules can
 * reassign it.
 */
export const ctx: {
  initCtx: BackendInitContext | null;
  poolConfig: TalonConfig | null;
} = {
  initCtx: null,
  poolConfig: null,
};

// ── Internal helpers ────────────────────────────────────────────────────────

/** Look up or initialise a pool entry for a backend id. */
export async function ensurePoolEntry(
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
  if (!ctx.initCtx) {
    throw new Error(
      "Backend pool not initialised — call initBackendPool first",
    );
  }
  const instance = await factory.init(config, ctx.initCtx);
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
export async function releaseHolderFromEntry(
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

export function notifyListeners(
  holder: BackendHolder,
  backend: Backend,
  ctxInfo: { id: string; label: string },
): void {
  for (const listener of listeners) {
    try {
      listener(holder, backend, ctxInfo);
    } catch (err) {
      logWarn(
        "backend-controller",
        `Backend-change listener threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function resolveRoleBackendId(
  role: "chat" | "heartbeat" | "dream",
  config: TalonConfig,
): string {
  switch (role) {
    case "chat":
      return config.backend;
    case "heartbeat":
      return config.heartbeatBackend ?? config.backend;
    case "dream":
      return config.dreamBackend ?? config.backend;
  }
}

/** Has the pool been initialised? */
export function hasBackendPool(): boolean {
  return bindings.has(roleHolder("chat"));
}
