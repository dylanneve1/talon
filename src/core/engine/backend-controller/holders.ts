/**
 * Holder-string constructors. A holder is any string the rest of Talon uses
 * to claim a backend reference: `role:chat`, `role:heartbeat`, `role:dream`,
 * or `chat:<chatId>` for per-chat overrides.
 */

import type { BackendHolder, BackendRole } from "./types.js";

/** Build the holder string for a role. */
export function roleHolder(role: BackendRole): BackendHolder {
  return `role:${role}`;
}

/** Build the holder string for a per-chat override. */
export function chatHolder(chatId: string): BackendHolder {
  return `chat:${chatId}`;
}
