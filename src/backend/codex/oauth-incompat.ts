/**
 * Runtime-learned Codex ChatGPT-OAuth model incompatibility store.
 *
 * The problem
 * ───────────
 *
 * The Codex CLI's ChatGPT-OAuth path silently rejects most model
 * strings: only `gpt-5.5` is known to work end-to-end on a free OAuth
 * account, but `~/.codex/models_cache.json` advertises every visible
 * model with `supported_in_api: true`. The CLI then exits 1 with no
 * structured error event on stdout — just `"Reading prompt from
 * stdin..."` on stderr — making the failure look opaque to the SDK.
 *
 * Talon's recovery ladder (`isChatGptModelMismatchError` in `auth.ts`)
 * can only fall back when the SDK surfaces the explicit
 * `"not supported when using Codex with a ChatGPT account"` text. When
 * Codex exits silently the explicit text never arrives → no recovery
 * fires → the user sees a dead turn.
 *
 * The fix
 * ───────
 *
 * Maintain a per-credential learning set of model ids that have been
 * observed failing on this OAuth account:
 *
 *   1. `markOAuthIncompat(id)` records a failure (writes through to
 *      `~/.talon/data/codex-oauth-incompat.json` keyed by current
 *      auth fingerprint).
 *   2. `isKnownOAuthIncompat(id)` answers the pre-emptive swap and the
 *      picker filter.
 *   3. `loadOAuthIncompatStore(fingerprint)` rehydrates the in-memory
 *      set at startup and ignores stale data from a different credential.
 *
 * The store is intentionally additive-only at the credential level: a
 * model that worked once may legitimately fail once (rate limit, server
 * error) — we don't want to mark it incompat. But the *silent exit 1*
 * pattern is a strong signal that the CLI refuses the model on this
 * auth, and that's the only failure shape that triggers a mark.
 *
 * Keyed by auth fingerprint
 * ─────────────────────────
 *
 * If Dylan switches OAuth accounts (e.g. work vs personal) the cache
 * file at `~/.codex/auth.json` changes, and what we learned about
 * account A doesn't necessarily apply to account B. To stay correct
 * across credential changes we tag the store with a fingerprint of the
 * auth source (`mode + source + first 32 chars of the token if any`).
 * Mismatched fingerprint on load → start fresh.
 *
 * No file at the path, parse error, missing fields — all treated as
 * "empty set" silently. Persistence is best-effort: a write failure
 * logs a warning but never throws, the in-memory set still works for
 * the rest of the session.
 *
 * Persistence
 * ───────────
 *
 * Backed by `core/agent-runtime/store.ts`'s `JsonStore<T>`. On-disk
 * format is the envelope `{ schemaVersion, savedAt, data:
 * { fingerprint, updatedAt, models } }`. A `migrate` hook accepts
 * the legacy bare-document shape (`{ version, fingerprint,
 * updatedAt, models }`) on first load so existing data isn't lost.
 *
 * API shape:
 *
 *   - `markOAuthIncompat(id)` is async (returns `Promise<boolean>`).
 *     The in-memory mutation is synchronous, but the disk write is
 *     awaited so callers can reason about ordering.
 *   - `loadOAuthIncompatStore(fingerprint)` is async — JsonStore
 *     loads are Promise-returning to allow for fake filesystem
 *     injection in tests.
 *   - `isKnownOAuthIncompat`, `listKnownOAuthIncompat`,
 *     `computeAuthFingerprint`, and `resetOAuthIncompatForTests`
 *     stay synchronous (they only touch the in-memory set, not
 *     disk).
 */

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import { logDebug, logWarn } from "../../util/log.js";
import { JsonStore, type JsonStoreFs } from "../../core/agent-runtime/store.js";
import type { CodexAuthInfo } from "./auth.js";

/**
 * Resolve the store path AT CALL TIME rather than at module-init.
 *
 * `util/paths.ts` resolves all file paths against `homedir()` at
 * import time, which is fine in production but causes test pollution:
 * a test that overrides `process.env.HOME` to point at a tmp dir still
 * has the OLD path cached on `files.codexOauthIncompat`. Resolving
 * lazily here means HOME-override tests stay isolated AND production
 * behaviour is identical (homedir() is stable for the lifetime of a
 * real Talon process).
 */
function storePath(): string {
  return resolve(homedir(), ".talon", "data", "codex-oauth-incompat.json");
}

/**
 * Shape persisted INSIDE the JsonStore envelope. The on-disk
 * representation is `{ schemaVersion, savedAt, data: OAuthIncompatData }`
 * — `OAuthIncompatData` is what callers (and the migrate hook)
 * see as `data`.
 */
interface OAuthIncompatData {
  /** Fingerprint of the credential the store was learned against. */
  fingerprint: string;
  /** When the store was last mutated (ISO 8601). */
  updatedAt: string;
  /** Model ids known to fail on this credential, sorted. */
  models: string[];
}

const STORE_SCHEMA_VERSION = 1 as const;

/**
 * In-memory state for the active credential. Held in a module-
 * scoped variable rather than the `JsonStore` itself so reads
 * (`isKnownOAuthIncompat`, `listKnownOAuthIncompat`) stay synchronous —
 * the hot path doesn't need to touch disk.
 */
interface InMemoryStore {
  fingerprint: string;
  models: Set<string>;
}

let memoryStore: InMemoryStore | null = null;
let jsonStore: JsonStore<OAuthIncompatData> | null = null;

/**
 * Compute a stable fingerprint for the active auth credential. Used as
 * the store's identity tag so a credential change discards the learned
 * set without polluting a different account.
 *
 * Fingerprint shape:
 *   - `mode:source` for ChatGPT OAuth (no token to hash)
 *   - `mode:source:<first 16 chars of key>` for api-key billing
 *   - `mode:source` for missing/empty
 *
 * Constant-folded by `mode === "none"` — no learning happens without
 * authentication, so we only really care about the OAuth shape.
 */
export function computeAuthFingerprint(info: CodexAuthInfo): string {
  const base = `${info.mode}:${info.source}`;
  if (info.mode === "api-key" && info.apiKey) {
    // First 16 chars is enough to distinguish keys for fingerprint
    // purposes without storing the full secret on disk.
    return `${base}:${info.apiKey.slice(0, 16)}`;
  }
  return base;
}

/**
 * Optional filesystem injection — production uses node:fs, tests
 * can pass an in-memory implementation. Mirrors `JsonStoreFs`.
 */
export interface OAuthIncompatStoreOptions {
  fs?: JsonStoreFs;
}

/**
 * Load the persisted store for the given credential fingerprint, OR
 * reset the in-memory state to empty if the fingerprint doesn't match
 * (different account → don't trust the old data).
 *
 * Idempotent — safe to call from `initCodexAgent` on every (re)init.
 * Tolerates missing file, malformed JSON, and schema-version drift by
 * starting with an empty set + logging at debug.
 */
export async function loadOAuthIncompatStore(
  fingerprint: string,
  options: OAuthIncompatStoreOptions = {},
): Promise<void> {
  // Idempotent fast path: if we already have a memoryStore for the
  // same fingerprint, the existing in-memory set is authoritative
  // for this credential. Recomputing it from disk would discard any
  // runtime-learned entries that haven't completed their async
  // persist yet (the JsonStore migration made `markOAuthIncompat`
  // async, and `initCodexAgent` fires this loader and-forgets, so
  // there's a real race between mark+persist and a subsequent
  // loadOAuthIncompatStore on the same fingerprint).
  if (memoryStore && memoryStore.fingerprint === fingerprint && jsonStore) {
    return;
  }

  const freshMemory: InMemoryStore = {
    fingerprint,
    models: new Set<string>(),
  };
  const freshJsonStore = makeJsonStore(options.fs);

  let data: OAuthIncompatData;
  try {
    data = await freshJsonStore.load();
  } catch (err) {
    logWarn(
      "agent",
      `Codex OAuth-incompat store: load failed (${
        err instanceof Error ? err.message : String(err)
      }), starting empty`,
    );
    memoryStore = freshMemory;
    jsonStore = freshJsonStore;
    return;
  }

  // Commit the fresh state AFTER the await. Until this point the
  // module-level `memoryStore` holds the previous credential's data
  // (if any) — concurrent reads via `isKnownOAuthIncompat` keep
  // seeing it, and the swap is atomic from the reader's point of view.
  if (data.fingerprint !== fingerprint) {
    logDebug(
      "agent",
      `Codex OAuth-incompat store: fingerprint mismatch (was ${data.fingerprint}, now ${fingerprint}), starting empty`,
    );
    memoryStore = freshMemory;
    jsonStore = freshJsonStore;
    return;
  }

  for (const id of data.models) {
    if (typeof id === "string" && id) freshMemory.models.add(id);
  }
  memoryStore = freshMemory;
  jsonStore = freshJsonStore;
  logDebug(
    "agent",
    `Codex OAuth-incompat store: loaded ${freshMemory.models.size} entries from ${storePath()}`,
  );
}

/**
 * True when the given model id has been observed failing on the
 * currently-loaded credential.
 *
 * Defensive: returns `false` when no store is loaded (e.g. backend
 * never initialised, or auth mode is api-key where we don't learn).
 */
export function isKnownOAuthIncompat(modelId: string): boolean {
  return memoryStore?.models.has(modelId) ?? false;
}

/**
 * Record `modelId` as OAuth-incompat on the current credential.
 * Best-effort persistence to disk; in-memory mutation is always
 * effective even if the write fails.
 *
 * Returns `true` if the set changed (callers can log the new entry),
 * `false` if the id was already known.
 *
 * The in-memory mutation is synchronous so subsequent
 * `isKnownOAuthIncompat` calls see the update immediately; the
 * awaited promise covers the disk write through `JsonStore`.
 */
export async function markOAuthIncompat(modelId: string): Promise<boolean> {
  if (!memoryStore || !jsonStore) {
    logDebug(
      "agent",
      `Codex OAuth-incompat: markOAuthIncompat(${modelId}) called with no store loaded — ignored`,
    );
    return false;
  }
  if (memoryStore.models.has(modelId)) return false;

  memoryStore.models.add(modelId);
  // Mirror the in-memory mutation into the JsonStore's value, then
  // persist. JsonStore.update + save is the standard write pattern.
  jsonStore.update((data) => {
    data.fingerprint = memoryStore!.fingerprint;
    data.updatedAt = new Date().toISOString();
    data.models = Array.from(memoryStore!.models).sort();
  });
  await persist();
  return true;
}

/**
 * Snapshot of the currently-learned set. Returns an array (not the
 * underlying Set) so callers can't mutate state directly. Empty array
 * when no store is loaded.
 */
export function listKnownOAuthIncompat(): string[] {
  if (!memoryStore) return [];
  return Array.from(memoryStore.models).sort();
}

/**
 * Drop the in-memory state without touching disk. Used in tests to
 * isolate scenarios. Production callers should call
 * `loadOAuthIncompatStore` instead.
 */
export function resetOAuthIncompatForTests(): void {
  memoryStore = null;
  jsonStore = null;
}

// ── Internals ───────────────────────────────────────────────────────────────

function makeJsonStore(fs?: JsonStoreFs): JsonStore<OAuthIncompatData> {
  return new JsonStore<OAuthIncompatData>({
    path: storePath(),
    defaultValue: {
      fingerprint: "",
      updatedAt: new Date(0).toISOString(),
      models: [],
    },
    schemaVersion: STORE_SCHEMA_VERSION,
    validate: validateData,
    migrate: migrateLegacy,
    ...(fs ? { fs } : {}),
  });
}

/**
 * Validate the persisted `data` field shape. JsonStore calls this
 * with whatever the on-disk envelope's `data` was. Returns the
 * normalised value; throws to reject a malformed document.
 */
function validateData(raw: unknown): OAuthIncompatData {
  if (!raw || typeof raw !== "object") {
    throw new Error("malformed: not an object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fingerprint !== "string") {
    throw new Error("malformed: missing fingerprint");
  }
  if (typeof obj.updatedAt !== "string") {
    throw new Error("malformed: missing updatedAt");
  }
  if (!Array.isArray(obj.models)) {
    throw new Error("malformed: models is not an array");
  }
  return {
    fingerprint: obj.fingerprint,
    updatedAt: obj.updatedAt,
    models: obj.models.filter(
      (m): m is string => typeof m === "string" && m.length > 0,
    ),
  };
}

/**
 * Translate the pre-JsonStore on-disk shape into the new envelope.
 *
 *   Legacy:  { version: 1, fingerprint, updatedAt, models }
 *   New:     { schemaVersion: 1, savedAt, data: { fingerprint, updatedAt, models } }
 *
 * JsonStore reads the legacy shape as a bare document (no envelope
 * detected → `fromVersion: 0`). When `raw` has the legacy `version`
 * field set to 1, we lift the inner fields into the new envelope.
 * Anything else returns `null` → JsonStore falls back to default
 * (empty set), matching the prior behaviour where "schema mismatch
 * → start empty".
 */
function migrateLegacy(
  raw: unknown,
  fromVersion: number,
): { value: OAuthIncompatData; schemaVersion: number } | null {
  if (fromVersion !== 0) {
    // We only know how to migrate FROM the legacy bare shape (no
    // envelope detected) — anything else (e.g. a future newer
    // schema) is unrecoverable.
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  try {
    const data = validateData({
      fingerprint: obj.fingerprint,
      updatedAt: obj.updatedAt,
      models: obj.models,
    });
    return { value: data, schemaVersion: STORE_SCHEMA_VERSION };
  } catch {
    return null;
  }
}

/**
 * Persist the current in-memory state to disk. Best-effort — wraps
 * `JsonStore.save()` with directory creation and a swallowed-warning
 * fallback identical to the pre-migration `persist()`.
 */
async function persist(): Promise<void> {
  if (!jsonStore) return;
  try {
    mkdirSync(dirname(storePath()), { recursive: true });
    await jsonStore.save();
  } catch (err) {
    logWarn(
      "agent",
      `Codex OAuth-incompat store: persist failed (${
        err instanceof Error ? err.message : String(err)
      }) — in-memory state unaffected`,
    );
  }
}
