/**
 * Public types for the backend controller / pool.
 */

import type { Backend } from "../../agent-runtime/capabilities.js";

/** Roles that map to global holders. */
export type BackendRole = "chat" | "heartbeat" | "dream";

export const ALL_ROLES: readonly BackendRole[] = ["chat", "heartbeat", "dream"];

/** Holder identifier — opaque string. Use `roleHolder()` / `chatHolder()`. */
export type BackendHolder = string;

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
export type BackendChangeListener = (
  holder: BackendHolder,
  backend: Backend,
  ctx: { id: string; label: string },
) => void;
