/**
 * Drift guard for the embedded SQL — rebuilds
 * storage/sql/statements.generated.ts from the .sql sources and fails
 * if the committed artifact doesn't match (same idiom as the Gleam
 * artifact CI job). Plus parser edge cases.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSqlModule,
  parseNamedStatements,
  readSqlSources,
} from "../storage/sql/embed.js";
import * as generated from "../storage/sql/statements.generated.js";

const sqlDir = fileURLToPath(new URL("../storage/sql", import.meta.url));

describe("sql embed", () => {
  it("statements.generated.ts matches the .sql sources (run `npm run build:sql`)", () => {
    const expected = buildSqlModule(readSqlSources(sqlDir));
    // CRLF-normalize the committed artifact too: a Windows checkout
    // without the .gitattributes pin would otherwise diff on line
    // endings alone (sources are normalized inside readSqlSources).
    const committed = readFileSync(
      join(sqlDir, "statements.generated.ts"),
      "utf8",
    ).replaceAll("\r\n", "\n");
    expect(committed).toBe(expected);
  });

  it("every .sql store file has a generated export", () => {
    const { stores } = readSqlSources(sqlDir);
    // chat-settings → chatSettingsSql, etc.
    const exportNames = stores.map(
      ([name]) =>
        name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()) + "Sql",
    );
    for (const name of exportNames) {
      expect(generated, `missing export ${name}`).toHaveProperty(name);
    }
    expect(generated.SCHEMA).toContain("CREATE TABLE IF NOT EXISTS");
  });
});

describe("parseNamedStatements", () => {
  it("splits on -- name: markers and trims blocks", () => {
    const parsed = parseNamedStatements(
      "-- header comment\n\n-- name: a\nSELECT 1\n\n-- name: b\n-- doc\nSELECT 2\n",
      "x.sql",
    );
    expect(parsed.get("a")).toBe("SELECT 1");
    expect(parsed.get("b")).toBe("-- doc\nSELECT 2");
  });

  it("rejects duplicates, empty blocks, headerless SQL, markerless files", () => {
    expect(() =>
      parseNamedStatements(
        "-- name: a\nSELECT 1\n-- name: a\nSELECT 2",
        "x.sql",
      ),
    ).toThrow(/duplicate/);
    expect(() => parseNamedStatements("-- name: a\n\n", "x.sql")).toThrow(
      /empty statement/,
    );
    expect(() =>
      parseNamedStatements("SELECT 1\n-- name: a\nSELECT 2", "x.sql"),
    ).toThrow(/before the first/);
    expect(() => parseNamedStatements("-- only comments", "x.sql")).toThrow(
      /no "-- name:"/,
    );
  });
});
