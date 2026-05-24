/**
 * `JsonStore<T>` — unified persistence for the six JSON-backed
 * stores under `src/storage/`.
 *
 * Phase 6 of the architecture unification plan. The six current
 * stores (`chat-settings`, `cron-store`, `history`, `media-index`,
 * `sessions`, `trigger-store`) each reimplement the same shape:
 *
 *   - in-memory `Map` mirror
 *   - dirty flag + 10s autosave
 *   - `write-file-atomic` on save
 *   - `.bak` fallback on corrupt read
 *   - debounced writes during high-frequency mutations
 *
 * That's ~1.5k LOC of duplicated code with ~80% structural overlap.
 * This module provides the storage primitive; the per-store
 * migrations land in Phase 6.x PRs.
 *
 * Phase 1-2 contract: **no production store uses `JsonStore` yet.**
 * The plan recommends starting with Codex OAuth incompat learning
 * (low-risk, small state) and ending with chat-settings (high-risk,
 * operationally sensitive).
 *
 * Design notes
 * ────────────
 *
 *   - The store owns the file path + write semantics; consumers
 *     own the schema. `JsonStore<T>` is type-parametric on the
 *     persisted shape.
 *
 *   - `schemaVersion` + `migrate` hook lets consumers evolve the
 *     shape without forking storage code per-store.
 *
 *   - Corrupt JSON falls back to `<path>.bak` once before
 *     surrendering. Matches the existing stores' behaviour.
 *
 *   - Writes are atomic via `write-file-atomic` (rename-on-fsync).
 *     The store doesn't lock — concurrent processes mutating the
 *     same file is a separate problem (Talon assumes single-process
 *     ownership of `~/.talon/data/*`).
 *
 *   - Test-friendly: `JsonStoreOptions.now` and
 *     `JsonStoreOptions.fs` let tests inject a fake filesystem +
 *     clock without monkey-patching `node:fs`.
 *
 * Phase 6.x will migrate stores one at a time:
 *
 *   1. Codex OAuth incompat learning  (~150 LOC store, low risk)
 *   2. media index                    (~200 LOC store)
 *   3. cron jobs                      (~400 LOC store)
 *   4. triggers                       (~500 LOC store)
 *   5. sessions                       (~300 LOC store)
 *   6. chat settings                  (~400 LOC store, last — touch
 *                                       prod state too directly to
 *                                       migrate first)
 */

import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";

/**
 * Subset of the `node:fs` surface this module uses. Tests can
 * inject an in-memory implementation; production uses the default
 * (passes through to `node:fs`).
 */
export interface JsonStoreFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileAtomic(path: string, data: string): Promise<void>;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

const defaultFs: JsonStoreFs = {
  existsSync,
  readFileSync: (path) => readFileSync(path, "utf8"),
  writeFileAtomic: (path, data) =>
    new Promise((resolve, reject) => {
      writeFileAtomic(path, data, (err) => (err ? reject(err) : resolve()));
    }),
  renameSync,
  unlinkSync,
};

/**
 * Options for constructing a `JsonStore`.
 */
export interface JsonStoreOptions<T> {
  /** Absolute path on disk where the JSON document lives. */
  path: string;
  /** Initial value when no file (or backup) exists. */
  defaultValue: T;
  /**
   * Optional schema-validation hook. Returns the (possibly
   * normalised) value; throws to reject a malformed document.
   * Called on every load — corrupt JSON triggers the `.bak`
   * fallback path before this is invoked.
   */
  validate?: (raw: unknown) => T;
  /**
   * Optional migration. Called BEFORE `validate` with the parsed
   * raw value and the stored `schemaVersion` (or `0` when absent).
   * Should return the new value AND the up-to-date schemaVersion.
   *
   * If the migration returns `null`, the store treats the file as
   * unrecoverable and falls back to `defaultValue`.
   */
  migrate?: (
    raw: unknown,
    fromVersion: number,
  ) => { value: T; schemaVersion: number } | null;
  /** Current schema version; written alongside the data envelope. */
  schemaVersion?: number;
  /** Override clock — useful for tests. */
  now?: () => number;
  /** Override filesystem — useful for tests. */
  fs?: JsonStoreFs;
}

/**
 * Envelope persisted on disk:
 *
 *   {
 *     "schemaVersion": 1,
 *     "savedAt": 1716540000000,
 *     "data": { ... per-store shape ... }
 *   }
 *
 * The envelope is private to the store — consumers see only `data`.
 */
interface Envelope<T> {
  schemaVersion: number;
  savedAt: number;
  data: T;
}

/**
 * Unified JSON-backed store. Type-parametric on the persisted
 * shape `T`. Methods are async because writes go through atomic
 * fsync — even tests that want sync ergonomics should `await save()`.
 */
export class JsonStore<T> {
  #path: string;
  #defaultValue: T;
  #validate?: (raw: unknown) => T;
  #migrate?: JsonStoreOptions<T>["migrate"];
  #schemaVersion: number;
  #now: () => number;
  #fs: JsonStoreFs;
  #value: T;
  #loaded = false;
  #dirty = false;

  constructor(options: JsonStoreOptions<T>) {
    this.#path = options.path;
    // Deep-clone the default value so caller mutations on `#value`
    // (via update()) don't bleed into the constructor argument.
    // Otherwise two stores constructed with the same defaultValue
    // object would share mutable state.
    this.#defaultValue = cloneJsonValue(options.defaultValue);
    this.#validate = options.validate;
    this.#migrate = options.migrate;
    this.#schemaVersion = options.schemaVersion ?? 1;
    this.#now = options.now ?? (() => Date.now());
    this.#fs = options.fs ?? defaultFs;
    this.#value = cloneJsonValue(options.defaultValue);
  }

  /**
   * Load from disk. Returns the current value either way.
   *
   * Lookup order:
   *   1. `<path>`            — primary
   *   2. `<path>.bak`        — promoted to primary on corrupt JSON
   *   3. `defaultValue`      — when neither exists or both are
   *                            unrecoverable.
   *
   * `migrate` is called before `validate` when the on-disk
   * envelope's `schemaVersion` differs from the constructor's.
   * Idempotent — repeat calls return the cached value without
   * re-reading.
   */
  async load(): Promise<T> {
    if (this.#loaded) return this.#value;
    const fromPrimary = this.#tryReadFile(this.#path);
    if (fromPrimary.ok) {
      this.#value = fromPrimary.value;
      this.#loaded = true;
      return this.#value;
    }
    const fromBackup = this.#tryReadFile(this.#path + ".bak");
    if (fromBackup.ok) {
      this.#value = fromBackup.value;
      this.#loaded = true;
      // Promote the backup back to primary so the next read picks
      // it up directly.
      try {
        this.#fs.renameSync(this.#path + ".bak", this.#path);
      } catch {
        // Best effort — leaving the .bak in place is safe.
      }
      return this.#value;
    }
    this.#value = cloneJsonValue(this.#defaultValue);
    this.#loaded = true;
    return this.#value;
  }

  /**
   * Get the current in-memory value. Loads on first access via the
   * cached path (if already loaded). Caller must `await load()`
   * first if first access could race with a write.
   */
  get(): T {
    return this.#value;
  }

  /**
   * Mutate the value via a callback. The function receives the
   * current value (read-write reference); side effects on it are
   * persisted on the next `save()`.
   *
   * Marks the store dirty. Does NOT autosave — pair with `save()`
   * or with a higher-level autosave timer.
   */
  update(fn: (value: T) => void): void {
    fn(this.#value);
    this.#dirty = true;
  }

  /**
   * Replace the entire value. Marks dirty.
   */
  set(value: T): void {
    this.#value = value;
    this.#dirty = true;
  }

  /**
   * Whether there are unsaved changes since the last `save()`.
   */
  isDirty(): boolean {
    return this.#dirty;
  }

  /**
   * Persist to disk atomically. No-op when not dirty. Writes the
   * envelope:
   *
   *   { schemaVersion, savedAt, data }
   *
   * via `write-file-atomic` (rename-on-fsync).
   */
  async save(): Promise<void> {
    if (!this.#dirty) return;
    const envelope: Envelope<T> = {
      schemaVersion: this.#schemaVersion,
      savedAt: this.#now(),
      data: this.#value,
    };
    const serialised = JSON.stringify(envelope, null, 2);
    await this.#fs.writeFileAtomic(this.#path, serialised);
    this.#dirty = false;
  }

  /**
   * Force-save regardless of dirty flag. Useful for migrations
   * where the in-memory value was rewritten by `migrate` but the
   * store hasn't seen a mutation yet.
   */
  async forceSave(): Promise<void> {
    this.#dirty = true;
    await this.save();
  }

  /**
   * Forget the in-memory state and force a fresh read on the next
   * `load()`. Test-only utility.
   */
  reset(): void {
    this.#value = cloneJsonValue(this.#defaultValue);
    this.#loaded = false;
    this.#dirty = false;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  #tryReadFile(path: string): { ok: true; value: T } | { ok: false } {
    if (!this.#fs.existsSync(path)) return { ok: false };
    let raw: string;
    try {
      raw = this.#fs.readFileSync(path, "utf8");
    } catch {
      return { ok: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false };
    }
    return this.#applyEnvelope(parsed);
  }

  #applyEnvelope(raw: unknown): { ok: true; value: T } | { ok: false } {
    // Accept either the new envelope shape OR a bare data document
    // (for back-compat with stores that pre-date the envelope).
    let onDiskVersion = 0;
    let data: unknown;
    if (
      raw &&
      typeof raw === "object" &&
      "schemaVersion" in raw &&
      "data" in raw
    ) {
      onDiskVersion = Number((raw as Envelope<unknown>).schemaVersion) || 0;
      data = (raw as Envelope<unknown>).data;
    } else {
      data = raw;
    }

    if (this.#migrate && onDiskVersion !== this.#schemaVersion) {
      const migrated = this.#migrate(data, onDiskVersion);
      if (!migrated) return { ok: false };
      this.#schemaVersion = migrated.schemaVersion;
      data = migrated.value;
    }

    let validated: T;
    if (this.#validate) {
      try {
        validated = this.#validate(data);
      } catch {
        return { ok: false };
      }
    } else {
      validated = data as T;
    }
    return { ok: true, value: validated };
  }
}

/**
 * Best-effort deep clone for JSON-serialisable values. Falls back
 * to `structuredClone` (Node 18+) and finally a JSON round-trip
 * for older runtimes. We deliberately don't support functions /
 * Date / Map / Set — `JsonStore` is for JSON state, not arbitrary
 * objects.
 */
function cloneJsonValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON path.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
