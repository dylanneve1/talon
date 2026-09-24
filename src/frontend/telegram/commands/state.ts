/**
 * Shared command state + helpers.
 *
 * The admin user id (set from talon.json / TALON_ADMIN_USER_ID via
 * `setAdminUserId`) is shared across the command groups, so it lives on a
 * holder object here. `RegisterDeps` is the bundle every group's register
 * function receives.
 */

import type { Context } from "grammy";
import type { Backend } from "../../../core/agent-runtime/capabilities.js";

/** Admin user ID is set via talon.json or TALON_ADMIN_USER_ID env var. */
const adminState = { adminUserId: 0 };

/** Set the admin user ID (called from config at startup). */
export function setAdminUserId(id: number | undefined): void {
  adminState.adminUserId = id ?? 0;
}

/**
 * True when the sender may run admin commands: an admin id is configured and
 * the sender is that user. "No admin configured" means nobody is admin —
 * never everyone (the Telegram frontend also refuses to start without one).
 */
export function isAuthorizedAdmin(ctx: Context): boolean {
  return (
    adminState.adminUserId !== 0 && ctx.from?.id === adminState.adminUserId
  );
}

/**
 * Same rule as `isAuthorizedAdmin`; kept as the name the irreversible
 * account actions check, so their intent stays explicit at the call site.
 */
export function isConfiguredAdmin(ctx: Context): boolean {
  return isAuthorizedAdmin(ctx);
}

export type RegisterDeps = {
  config: import("../../../core/config/index.js").TalonConfig;
  gateway?: { backend: Backend | null };
};
