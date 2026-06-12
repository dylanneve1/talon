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
 * schema.sql is embedded whole as `export const SCHEMA`. Each other
 * <store>.sql is split into named blocks (`-- name: <key>` markers)
 * and emitted as `export const <store>Sql = { <key>: "...", ... }`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SqlSources = {
  /** Content of schema.sql — the complete idempotent DDL. */
  schema: string;
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

/**
 * Read a .sql source with line endings normalized to LF. Belt to the
 * .gitattributes braces: a Windows checkout (or editor) that produces
 * CRLF must not change the embedded bytes, or the drift test fails on
 * exactly one OS.
 */
function readSqlFile(path: string): string {
  return readFileSync(path, "utf8").replaceAll("\r\n", "\n");
}

export function readSqlSources(dir: string): SqlSources {
  return {
    schema: readSqlFile(join(dir, "schema.sql")),
    stores: readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && f !== "schema.sql")
      .sort()
      .map((f) => [f.replace(/\.sql$/, ""), readSqlFile(join(dir, f))]),
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
  if (!sources.schema.trim()) throw new Error("schema.sql is empty");
  const parts: string[] = [
    "// AUTO-GENERATED FILE — DO NOT EDIT.",
    "// Source of truth: the .sql files in this directory.",
    "// Regenerate with `npm run build:sql` (drift-guarded by sql-embed.test.ts).",
    "",
    "/** The complete idempotent schema, ensured on every open (db.ts). */",
    `export const SCHEMA = ${templateLiteral(sources.schema.trim())};`,
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
