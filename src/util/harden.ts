/**
 * At-rest permission hardening for ~/.talon/.
 *
 * The tree holds credentials (config.json carries bot tokens, API keys and
 * the bridge token; .user-session is a full Telegram login) plus chat
 * history and logs. Node creates most of it with umask defaults, so on a
 * multi-user machine everything is group/world readable. This pass clamps
 * the sensitive surface to owner-only on every boot — idempotent, cheap,
 * and it repairs installs created before the tightened modes existed.
 *
 * Best-effort by design: a missing path just hasn't been created yet, and
 * a chmod failure (read-only mount, foreign owner) must never block boot.
 * Windows has no POSIX modes worth mapping, so the pass is a no-op there.
 */

import { chmodSync } from "node:fs";
import { dirs, files } from "./paths.js";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

/** Owner-only directories: everything under them inherits the protection. */
const HARDENED_DIRS: readonly string[] = [dirs.root, dirs.data, dirs.keys];

/** Belt-and-braces owner-only files, should they ever move out of the tree. */
const HARDENED_FILES: readonly string[] = [
  files.config,
  files.log,
  files.database,
  files.userSession,
];

/** Clamp permissions on the sensitive parts of ~/.talon/. */
export function hardenTalonPermissions(): void {
  if (process.platform === "win32") return;
  for (const dir of HARDENED_DIRS) {
    try {
      chmodSync(dir, OWNER_DIR);
    } catch {
      // absent or not ours — nothing to protect yet
    }
  }
  for (const file of HARDENED_FILES) {
    try {
      chmodSync(file, OWNER_FILE);
    } catch {
      // absent or not ours — nothing to protect yet
    }
  }
}
