/**
 * One-shot import of a legacy JSON store into SQLite.
 *
 * Every pre-SQLite store followed the same on-disk conventions, so
 * they share one import path: accept either the JsonStore envelope
 * ({ schemaVersion, savedAt, data }) or the even older bare document,
 * hand the payload to the store's ingest function, then rename the
 * file to `<path>.imported` so the import never re-runs (and the old
 * data stays recoverable). A failed import leaves the file in place
 * and logs — the store starts empty rather than crashing boot.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { log, logError, type LogComponent } from "../util/log.js";

export function importLegacyJson(options: {
  /** Absolute path of the legacy JSON file. */
  path: string;
  /** Log category — the importing store's own. */
  category: LogComponent;
  /** Plural noun for the log line, e.g. "session(s)". */
  what: string;
  /** Write the unwrapped payload into SQLite; returns rows imported. */
  ingest: (data: unknown) => number;
}): void {
  // Test isolation: suites that don't mock HOME would otherwise rename
  // the user's REAL legacy JSON during import (observed live). The
  // vitest setup sets this; import-testing suites unset it locally.
  if (process.env.TALON_DISABLE_LEGACY_IMPORT === "1") return;
  const { path, category, what, ingest } = options;
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const data =
      raw && typeof raw === "object" && "data" in raw
        ? (raw as { data: unknown }).data
        : raw;
    const imported = ingest(data);
    renameSync(path, `${path}.imported`);
    // The store is named via `category`/`what` only — interpolating the
    // path here trips CodeQL's clear-text-logging heuristics for stores
    // whose filename resembles a credential (codex-oauth-incompat.json).
    log(category, `Imported ${imported} ${what} from legacy JSON into SQLite`);
  } catch (err) {
    logError(category, `Legacy ${what} import failed`, err);
  }
}
