/**
 * SQLite connection + migration runner — the high-performance data
 * layer's entry point.
 *
 * One database at ~/.talon/data/talon.db, opened through `node:sqlite`
 * (stable since Node 23.4; bun implements the same module on top of
 * its built-in SQLite, so compiled binaries need no native addon).
 * The heavy lifting — storage engine, indexes, FTS5 full-text search —
 * is battle-tested C, orchestrated from TypeScript.
 *
 * Layering (keep it this way):
 *   - schema.ts                 all DDL, versioned migrations
 *   - repositories/<store>.ts   all statements for one store, typed rows
 *   - <store>.ts                public API + domain logic, ZERO SQL
 *   - db.ts (this file)         connection, pragmas, migration cursor
 *
 * Why this over the JSON stores it replaces: transactional row writes
 * instead of rewrite-the-whole-file flush timers, indexed reads instead
 * of in-memory scans (so retention needn't be capped), and FTS5 where
 * stores need real search.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { files } from "../util/paths.js";
import { log } from "../util/log.js";
import { MIGRATIONS } from "./schema.js";

let db: DatabaseSync | null = null;

function migrate(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    const step = MIGRATIONS[version];
    database.exec("BEGIN");
    try {
      database.exec(step);
      version += 1;
      database.exec(`PRAGMA user_version = ${version}`);
      database.exec("COMMIT");
    } catch (err) {
      database.exec("ROLLBACK");
      throw err;
    }
    log("db", `Migrated database to schema v${version}`);
  }
}

function defaultPath(): string {
  // Test isolation: the vitest setup file points every worker at a
  // throwaway database so suites never touch ~/.talon/data/talon.db.
  return process.env.TALON_DB_PATH || files.database;
}

/**
 * Open (or return) the process-wide database. The first call wins the
 * path; tests pass an explicit tmp path and call closeDatabase() in
 * teardown.
 */
export function getDatabase(path: string = defaultPath()): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  // WAL: readers don't block the writer, and crash recovery is
  // journal-based instead of "hope the rename was atomic".
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  migrate(database);
  db = database;
  return database;
}

/** Run `fn` inside a transaction; rolls back on throw. */
export function inTransaction<T>(fn: () => T): T {
  const database = getDatabase();
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  }
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}
