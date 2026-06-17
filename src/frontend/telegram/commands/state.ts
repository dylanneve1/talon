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
export const adminState = { adminUserId: 0 };

/** Set the admin user ID (called from config at startup). */
export function setAdminUserId(id: number | undefined): void {
  adminState.adminUserId = id ?? 0;
}

/**
 * True when the sender is allowed to run admin commands — either no admin is
 * configured (id 0) or the sender matches. Matches the original inline guard.
 */
export function isAuthorizedAdmin(ctx: Context): boolean {
  return (
    adminState.adminUserId === 0 || ctx.from?.id === adminState.adminUserId
  );
}

export type RegisterDeps = {
  config: import("../../../util/config.js").TalonConfig;
  gateway?: { backend: Backend | null };
};
