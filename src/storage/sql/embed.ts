/**
 * SQL embedding — turns the .sql files in this directory into the
 * committed `statements.generated.ts` module.
 *
 * The .sql files are the source of truth (editor highlighting, no
 * template-literal noise), but compiled single-binary builds
 * (`bun build --compile`) have no source tree at runtime, so the
 * statements must travel inside the bundle as a TypeScript module.
 * Same committed-artifact idiom as the Gleam scheduler core and the
 * BLAKE3 WASM module: edit the .sql, run `npm run build:sql`, commit
 * both; sql-embed.test.ts fails CI on drift.
 *
 * Formats:
 *   - migrations/NNN_*.sql — whole-file migration steps, ordered by
 *     filename; appended to the MIGRATIONS array (cursor is
 *     `PRAGMA user_version`, see db.ts). Never edit or reorder a
 *     shipped migration — add a new file.
 *   - <store>.sql — named statements, one per `-- name: <key>` marker;
 *     emitted as `export const <store>Sql = { <key>: "...", ... }`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SqlSources = {
  /** Migration steps in apply order: [filename, content]. */
  migrations: Array<[string, string]>;
  /** Store statement files: [basename without .sql, content]. */
  stores: Array<[string, string]>;
};

const MARKER = /^--\s*name:\s*([A-Za-z_$][\w$]*)\s*$/;

/** Split a store .sql file into its `-- name:` blocks. */
export function parseNamedStatements(
  content: string,
  filename: string,
): Map<string, string> {
  const statements = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];

  const flush = () => {
    if (current === null) return;
    const sql = lines.join("\n").trim();
    if (!sql) throw new Error(`${filename}: empty statement "${current}"`);
    statements.set(current, sql);
  };

  for (const line of content.split("\n")) {
    const marker = MARKER.exec(line);
    if (marker) {
      flush();
      if (statements.has(marker[1])) {
        throw new Error(`${filename}: duplicate statement "${marker[1]}"`);
      }
      current = marker[1];
      lines = [];
    } else if (current !== null) {
      lines.push(line);
    } else if (line.trim() && !line.startsWith("--")) {
      throw new Error(
        `${filename}: SQL before the first "-- name:" marker: ${line.trim()}`,
      );
    }
  }
  flush();
  if (statements.size === 0) {
    throw new Error(`${filename}: no "-- name:" markers found`);
  }
  return statements;
}

export function readSqlSources(dir: string): SqlSources {
  const sqlFiles = (d: string) =>
    readdirSync(d)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  return {
    migrations: sqlFiles(join(dir, "migrations")).map((f) => [
      f,
      readFileSync(join(dir, "migrations", f), "utf8"),
    ]),
    stores: sqlFiles(dir).map((f) => [
      f.replace(/\.sql$/, ""),
      readFileSync(join(dir, f), "utf8"),
    ]),
  };
}

/** `chat-settings` → `chatSettingsSql` */
function exportName(basename: string): string {
  return basename.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()) + "Sql";
}

function templateLiteral(sql: string): string {
  return `\`${sql.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
}

/** Render the full statements.generated.ts module text. */
export function buildSqlModule(sources: SqlSources): string {
  if (sources.migrations.length === 0) {
    throw new Error("no migration files found");
  }
  const parts: string[] = [
    "// AUTO-GENERATED FILE — DO NOT EDIT.",
    "// Source of truth: the .sql files in this directory.",
    "// Regenerate with `npm run build:sql` (drift-guarded by sql-embed.test.ts).",
    "",
    "/** Append-only migration list; cursor is `PRAGMA user_version` (db.ts). */",
    "export const MIGRATIONS: readonly string[] = [",
    ...sources.migrations.map(
      ([name, sql]) => `  // ${name}\n  ${templateLiteral(sql.trim())},`,
    ),
    "];",
  ];
  for (const [basename, content] of sources.stores) {
    parts.push("", `export const ${exportName(basename)} = {`);
    for (const [key, sql] of parseNamedStatements(content, `${basename}.sql`)) {
      parts.push(`  ${key}: ${templateLiteral(sql)},`);
    }
    parts.push("} as const;");
  }
  return parts.join("\n") + "\n";
}
