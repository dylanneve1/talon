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
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";

import { logDebug, logWarn } from "../../util/log.js";
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
 * Shape of the persisted store. `fingerprint` lets us discard the
 * learned set when the underlying credential changes.
 */
interface OAuthIncompatStore {
  /** Schema version — bumped on incompatible layout changes. */
  version: 1;
  /** Fingerprint of the credential the store was learned against. */
  fingerprint: string;
  /** When the store was last mutated (ISO 8601). */
  updatedAt: string;
  /** Model ids known to fail on this credential. */
  models: string[];
}

const STORE_VERSION = 1 as const;

/** In-memory state for the active credential. */
interface InMemoryStore {
  fingerprint: string;
  models: Set<string>;
}

let memoryStore: InMemoryStore | null = null;

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
 * Load the persisted store for the given credential fingerprint, OR
 * reset the in-memory state to empty if the fingerprint doesn't match
 * (different account → don't trust the old data).
 *
 * Idempotent — safe to call from `initCodexAgent` on every (re)init.
 * Tolerates missing file, malformed JSON, and schema-version drift by
 * starting with an empty set + logging at debug.
 */
export function loadOAuthIncompatStore(fingerprint: string): void {
  memoryStore = { fingerprint, models: new Set<string>() };

  const path = storePath();
  if (!existsSync(path)) {
    logDebug(
      "agent",
      `Codex OAuth-incompat store: no file at ${path}, starting empty`,
    );
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    logWarn(
      "agent",
      `Codex OAuth-incompat store: read failed (${
        err instanceof Error ? err.message : String(err)
      }), starting empty`,
    );
    return;
  }

  let parsed: OAuthIncompatStore;
  try {
    parsed = JSON.parse(raw) as OAuthIncompatStore;
  } catch (err) {
    logWarn(
      "agent",
      `Codex OAuth-incompat store: JSON parse failed (${
        err instanceof Error ? err.message : String(err)
      }), starting empty`,
    );
    return;
  }

  if (
    !parsed ||
    parsed.version !== STORE_VERSION ||
    typeof parsed.fingerprint !== "string" ||
    !Array.isArray(parsed.models)
  ) {
    logDebug(
      "agent",
      `Codex OAuth-incompat store: malformed or version mismatch, starting empty`,
    );
    return;
  }

  if (parsed.fingerprint !== fingerprint) {
    logDebug(
      "agent",
      `Codex OAuth-incompat store: fingerprint mismatch (was ${parsed.fingerprint}, now ${fingerprint}), starting empty`,
    );
    return;
  }

  for (const id of parsed.models) {
    if (typeof id === "string" && id) memoryStore.models.add(id);
  }
  logDebug(
    "agent",
    `Codex OAuth-incompat store: loaded ${memoryStore.models.size} entries from ${path}`,
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
 */
export function markOAuthIncompat(modelId: string): boolean {
  if (!memoryStore) {
    logDebug(
      "agent",
      `Codex OAuth-incompat: markOAuthIncompat(${modelId}) called with no store loaded — ignored`,
    );
    return false;
  }
  if (memoryStore.models.has(modelId)) return false;

  memoryStore.models.add(modelId);
  persist();
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
}

/** Persist the current in-memory state to disk. Best-effort. */
function persist(): void {
  if (!memoryStore) return;
  const data: OAuthIncompatStore = {
    version: STORE_VERSION,
    fingerprint: memoryStore.fingerprint,
    updatedAt: new Date().toISOString(),
    models: Array.from(memoryStore.models).sort(),
  };
  try {
    const path = storePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic.sync(path, JSON.stringify(data, null, 2));
  } catch (err) {
    logWarn(
      "agent",
      `Codex OAuth-incompat store: persist failed (${
        err instanceof Error ? err.message : String(err)
      }) — in-memory state unaffected`,
    );
  }
}
