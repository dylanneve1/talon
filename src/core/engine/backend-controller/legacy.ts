/**
 * Legacy single-active aliases (chat role).
 *
 * Preserved so consumers that pre-date the pool refactor stay green.
 * All route to the chat role — the canonical "default" backend.
 */

import type { Backend } from "../../agent-runtime/capabilities.js";
import type { TalonConfig } from "../../../util/config.js";
import { type BackendInitContext } from "../../agent-runtime/backend-registry.js";
import { log } from "../../../util/log.js";
import { roleHolder } from "./holders.js";
import { pool, bindings, ctx, ensurePoolEntry } from "./state.js";
import {
  getBackendForRole,
  getBackendIdForRole,
  getBackendLabelForRole,
  cleanupBackendPool,
  resetBackendPoolForTest,
} from "./pool.js";
import { rebindRole } from "./rebind.js";
import type { RebindResult } from "./types.js";

/**
 * Initialise the controller with a single backend bound to the chat
 * role. Convenience for tests; production should use `initBackendPool`.
 */
export async function initBackendController(
  id: string,
  config: TalonConfig,
  initContext: BackendInitContext,
): Promise<Backend> {
  ctx.initCtx = initContext;
  ctx.poolConfig = config;
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
