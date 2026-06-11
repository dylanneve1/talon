/**
 * Vitest worker setup: point the lazily-opened SQLite database
 * (storage/db.ts) at a throwaway per-worker file so no suite ever
 * touches the real ~/.talon/data/talon.db. Spawned child processes
 * inherit the env and stay isolated too.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.TALON_DB_PATH = join(
  tmpdir(),
  `talon-vitest-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
);

// Block legacy-JSON import/rename outside suites that explicitly test it.
process.env.TALON_DISABLE_LEGACY_IMPORT = "1";
