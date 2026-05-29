/**
 * `JsonStore<T>` — unified persistence for every JSON-backed store
 * under `src/storage/`.
 *
 * All seven JSON-backed stores (`chat-settings`, `cron-store`,
 * `history`, `media-index`, `sessions`, `trigger-store`, plus codex
 * `oauth-incompat`) are backed by this primitive.
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
 *   - Each write first copies the existing primary to `<path>.bak`,
 *     so a primary that later goes corrupt falls back to the previous
 *     good copy on the next load. Matches the legacy stores' behaviour.
 *
 *   - Writes are atomic via `write-file-atomic` (rename-on-fsync).
 *     The store doesn't lock — concurrent processes mutating the
 *     same file is a separate problem (Talon assumes single-process
 *     ownership of `~/.talon/data/*`).
 *
 *   - Sync + async twin pairs: `load`/`loadSync`, `save`/`saveSync`.
 *     The sync variants are required by stores wired into bootstrap
 *     and `cleanup-registry` where the event loop hasn't drained
 *     yet and the in-memory state must be primed before the first
 *     synchronous read.
 *
 *   - Test-friendly: `JsonStoreOptions.now` and `JsonStoreOptions.fs`
 *     let tests inject a fake filesystem + clock without
 *     monkey-patching `node:fs`.
 */

import * as nodeFs from "node:fs";
import writeFileAtomic from "write-file-atomic";

/**
 * Subset of the `node:fs` surface this module uses. Tests can
 * inject an in-memory implementation; production uses the default
 * (passes through to `node:fs`).
 *
 * `writeFileAtomicSync` is optional — async-only fakes (tests that
 * never call `saveSync`) can omit it. Stores that want a synchronous
 * persistence path (storage modules wired into cleanup-registry
 * before the event loop drains) require it.
 */
export interface JsonStoreFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileAtomic(path: string, data: string): Promise<void>;
  writeFileAtomicSync?(path: string, data: string): void;
  renameSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

/**
 * Default `JsonStoreFs` over `node:fs`. The `node:fs` accesses are
 * lazy (looked up on the namespace object at call time rather than
 * destructured at module load) so test files can mock a subset of
 * the fs surface without crashing JsonStore's import. The full
 * surface (`existsSync`, `readFileSync`, `renameSync`, `unlinkSync`,
 * plus `writeFileAtomic` for primary writes) is only exercised by
 * stores that go to disk; tests that never hit those code paths can
 * safely omit the corresponding mock entries.
 */
const defaultFs: JsonStoreFs = {
  existsSync: (path) => nodeFs.existsSync(path),
  readFileSync: (path) => nodeFs.readFileSync(path, "utf8"),
  writeFileAtomic: (path, data) =>
    new Promise((resolve, reject) => {
      writeFileAtomic(path, data, (err) => (err ? reject(err) : resolve()));
    }),
  writeFileAtomicSync: (path, data) => writeFileAtomic.sync(path, data),
  renameSync: (from, to) => nodeFs.renameSync(from, to),
  unlinkSync: (path) => nodeFs.unlinkSync(path),
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
    return this.loadSync();
  }

  /**
   * Synchronous variant of `load`. Used by storage modules wired
   * into bootstrap / cleanup-registry where the event loop hasn't
   * drained yet and the in-memory state must be primed before the
   * first synchronous read.
   *
   * Both `load` and `loadSync` walk the same `<path>` → `<path>.bak`
   * → `defaultValue` ladder. The async form is preserved for callers
   * that want to opt into a fake fs whose `readFileSync` is async-
   * backed.
   */
  loadSync(): T {
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
    const serialised = this.#serialise();
    await this.#backupExistingPrimary();
    await this.#fs.writeFileAtomic(this.#path, serialised);
    this.#dirty = false;
  }

  /**
   * Synchronous save variant. Required by stores wired into
   * cleanup-registry shutdown hooks where the event loop is about
   * to terminate. The injected fs must implement
   * `writeFileAtomicSync` — async-only fakes throw.
   */
  saveSync(): void {
    if (!this.#dirty) return;
    if (!this.#fs.writeFileAtomicSync) {
      throw new Error(
        "JsonStore.saveSync: injected fs does not implement writeFileAtomicSync",
      );
    }
    const serialised = this.#serialise();
    this.#backupExistingPrimarySync();
    this.#fs.writeFileAtomicSync(this.#path, serialised);
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

  #serialise(): string {
    const envelope: Envelope<T> = {
      schemaVersion: this.#schemaVersion,
      savedAt: this.#now(),
      data: this.#value,
    };
    return JSON.stringify(envelope, null, 2);
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

  /**
   * Copy the current on-disk primary to `<path>.bak` before it is
   * overwritten, so a primary that later goes corrupt (a torn write
   * from an external cause, a bad disk sector, a manual edit) can
   * still recover the previous good copy via the `loadSync` fallback
   * ladder. Best-effort: a backup failure must never block — or
   * mask the error of — the primary write that follows.
   */
  async #backupExistingPrimary(): Promise<void> {
    if (!this.#fs.existsSync(this.#path)) return;
    try {
      const current = this.#fs.readFileSync(this.#path, "utf8");
      await this.#fs.writeFileAtomic(this.#path + ".bak", current);
    } catch {
      // Best effort — see doc comment.
    }
  }

  /** Synchronous twin of `#backupExistingPrimary`. */
  #backupExistingPrimarySync(): void {
    if (!this.#fs.writeFileAtomicSync) return;
    if (!this.#fs.existsSync(this.#path)) return;
    try {
      const current = this.#fs.readFileSync(this.#path, "utf8");
      this.#fs.writeFileAtomicSync(this.#path + ".bak", current);
    } catch {
      // Best effort — see doc comment.
    }
  }

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
