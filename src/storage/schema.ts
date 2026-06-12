/**
 * Database schema — loader for the versioned migration files in
 * `migrations/*.sql`.
 *
 * Every piece of DDL lives in those .sql files, one file per
 * migration, named `NNN-description.sql` and applied in numeric
 * order; the cursor is SQLite's `PRAGMA user_version` (see db.ts).
 * Never edit or reorder a shipped migration — add a new file.
 *
 * SQL lives in .sql files, not embedded strings: schema is content,
 * not code — reviewable and editable with SQL tooling. (An older
 * revision embedded the strings here for `bun build --compile`
 * single-binary support, but compiled binaries are explicitly
 * unsupported — see README — and the package already ships non-TS
 * runtime assets the same way: prompts/, this directory.)
 *
 * Loading is lazy and cached, and goes through
 * `process.getBuiltinModule("node:fs")` rather than an `import`:
 * migration files are package assets (like the SQL strings they
 * replaced — present wherever the package is), so test suites that
 * mock `node:fs` to feed legacy-JSON fixtures must not be able to
 * corrupt the schema underneath the store they're testing.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fs = process.getBuiltinModule("node:fs");

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

let cached: readonly string[] | null = null;

/** The ordered migration list. Read once per process, then cached. */
export function loadMigrations(): readonly string[] {
  if (cached) return cached;
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+-.*\.sql$/.test(f))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  if (files.length === 0) {
    throw new Error(`No migration files found in ${MIGRATIONS_DIR}`);
  }
  cached = files.map((f) =>
    fs.readFileSync(resolve(MIGRATIONS_DIR, f), "utf-8"),
  );
  return cached;
}
