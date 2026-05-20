/**
 * OpenAI model discovery for the Codex backend.
 *
 * Why this is a separate module
 * ─────────────────────────────
 *
 * Codex ships with a small set of model strings hardcoded in the CLI,
 * but the actual set the operator can call depends on what their auth
 * credential is allowed to invoke. For api-key billing this is fully
 * dynamic — OpenAI keeps adding (and occasionally removing) models —
 * and the only reliable way to know what works is to ask the API:
 *
 *     GET https://api.openai.com/v1/models
 *
 * For ChatGPT-OAuth users the situation is different: there's no
 * `/v1/models` equivalent for the OAuth credential type, and the Codex
 * CLI silently rejects most model strings on this auth mode. We keep
 * the curated fallback for that path and don't probe at all.
 *
 * Design constraints (mirrors openai-agents/discovery.ts):
 *
 *   1. **First /model after a backend switch must show the catalog.**
 *      The fetch returns in ~200ms over a warm TLS session; we expose
 *      the in-flight promise via `awaitDiscovery(timeoutMs)` so the
 *      picker can soft-wait (3s default) before snapshotting.
 *
 *   2. **Bootstrap must not block on the network.** `initCodexAgent`
 *      calls `startDiscovery()` fire-and-forget; bootstrap proceeds and
 *      the catalog populates in the background.
 *
 *   3. **Tolerant by design.** Network errors, 401s, malformed entries —
 *      all swallowed and logged at debug. The resolver falls back to
 *      the curated catalog and the next manual refresh gets a fresh
 *      chance.
 *
 * Self-contained: talks to the network, mutates only
 * `state.discoveredModels` / `state.discoveryPromise` / `state.discoveryAt`,
 * exposes no side-effects beyond that.
 */

import { log, logDebug } from "../../util/log.js";
import { getState } from "./state.js";

/** Shape of one entry returned by OpenAI's `/v1/models`. Sparse — only `id` is reliably present. */
interface OpenAiModelEntry {
  id?: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

/** Default soft timeout when callers await an in-flight discovery. */
const DEFAULT_AWAIT_TIMEOUT_MS = 3_000;

/** Hard timeout for the underlying HTTP fetch. */
const FETCH_TIMEOUT_MS = 10_000;

/** Default OpenAI base URL when not overridden via config. */
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Drop model ids that don't make sense for Codex (a chat-completion
 * agent). The OpenAI `/v1/models` response is a kitchen sink — image
 * generation (`dall-e-*`), audio (`whisper-*`, `tts-*`), embeddings
 * (`text-embedding-*`), moderation, and legacy completions live next
 * to the actual chat models we want.
 *
 * Positive pattern: keep `gpt-3+`, `gpt-4+`, `gpt-5+`, `o3*`, `o4*`,
 * `chatgpt-*` (e.g. `chatgpt-4o-latest`). Everything else is filtered.
 *
 * Returns `true` to KEEP the model, `false` to drop. Exported for tests.
 */
export function isCodexCompatibleModel(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  const lower = id.toLowerCase();
  // Hard-exclude obviously non-chat families even if they accidentally
  // match the positive prefixes (e.g. `gpt-4o-audio-preview`).
  if (
    /(embedding|moderation|whisper|tts|dall-e|audio|realtime|search|babbage|davinci|ada|curie)/.test(
      lower,
    )
  ) {
    return false;
  }
  // Positive prefixes for chat-capable / reasoning models.
  if (/^(gpt-[3-9]|o[3-9]|chatgpt-)/.test(lower)) return true;
  return false;
}

/**
 * Kick off model discovery as a fire-and-forget background fetch.
 *
 * Stashes the in-flight Promise on `state.discoveryPromise` so callers
 * that need a populated catalog can `await awaitDiscovery()` instead
 * of racing the network. Idempotent: a second call while one is in
 * flight returns the existing promise.
 *
 * Failures are logged at debug and never throw — the resolver falls
 * back to the curated catalog, and the next `refreshDiscovery` (or
 * subsequent `initCodexAgent`) gets a fresh chance.
 */
export function startDiscovery(
  apiKey: string | undefined,
  baseUrl?: string,
): Promise<void> {
  const state = getState();
  if (state.discoveryPromise) return state.discoveryPromise;

  // No api key → no point fetching (OAuth has no models endpoint).
  // Mark discovery as "completed with empty result" so awaitDiscovery
  // returns immediately and the picker falls through to curated.
  if (!apiKey) {
    state.discoveryAt = Date.now();
    return Promise.resolve();
  }

  const promise = fetchOpenAiModels(apiKey, baseUrl)
    .catch((err) => {
      logDebug(
        "agent",
        `Codex model discovery skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    })
    .finally(() => {
      // Mark discovery attempted regardless of outcome — the picker
      // uses `discoveryAt` to distinguish "still loading" from
      // "finished, found nothing", and a transient failure should
      // fall through to curated immediately rather than wait again.
      state.discoveryAt = Date.now();
      if (state.discoveryPromise === promise) {
        state.discoveryPromise = null;
      }
    });

  state.discoveryPromise = promise;
  return promise;
}

/**
 * Wait for an in-flight discovery to complete, with a soft timeout.
 *
 * Returns immediately when no discovery is pending (either because it
 * finished or none was ever started). Used by the model picker before
 * snapshotting — keeps the first render honest without blocking the
 * UI for slow / unreachable endpoints.
 */
export async function awaitDiscovery(
  timeoutMs: number = DEFAULT_AWAIT_TIMEOUT_MS,
): Promise<void> {
  const state = getState();
  const inFlight = state.discoveryPromise;
  if (!inFlight) return;

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs));
  });
  try {
    await Promise.race([inFlight, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Force a fresh `/v1/models` fetch even when one was attempted before.
 *
 * Useful when the operator changes the API key at runtime or wants to
 * retry after a transient failure. Returns the new promise so callers
 * can await; safe to fire-and-forget.
 */
export function refreshDiscovery(
  apiKey: string | undefined,
  baseUrl?: string,
): Promise<void> {
  const state = getState();
  state.discoveryPromise = null;
  state.discoveryAt = null;
  return startDiscovery(apiKey, baseUrl);
}

/**
 * Whether the catalog has at least one discovered entry. Used by the
 * picker to decide whether awaiting in-flight discovery is worthwhile.
 */
export function hasDiscoveredCatalog(): boolean {
  return getState().discoveredModels.size > 0;
}

/**
 * Whether discovery has been attempted (regardless of result). Used by
 * the picker to distinguish "still loading" from "finished, found
 * nothing" — the latter falls back to curated immediately.
 */
export function hasAttemptedDiscovery(): boolean {
  return getState().discoveryAt !== null;
}

/**
 * Query OpenAI's `/v1/models` endpoint and populate
 * `state.discoveredModels` with the chat-compatible ids.
 *
 * The response is sparse — only `id` and `owned_by` are reliably
 * present. We don't try to enrich here; capability metadata
 * (contextWindow, displayName, reasoning, apiKeyOnly) lives in the
 * curated `CODEX_MODELS` table in `models.ts` and gets merged at
 * presentation time. Discovery only answers "which ids can this key
 * call?" — that's enough to drive the picker.
 *
 * Non-2xx responses throw so the caller can decide whether to
 * log-and-forget or retry.
 */
export async function fetchOpenAiModels(
  apiKey: string,
  baseUrl?: string,
): Promise<void> {
  const base = (baseUrl || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const url = `${base}/models`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`/v1/models returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: OpenAiModelEntry[] };
  const data = Array.isArray(json?.data) ? json.data : [];

  const state = getState();
  // Clear so a refresh fully replaces the set (no stale ids surviving
  // a model deprecation on OpenAI's side).
  state.discoveredModels.clear();
  let kept = 0;
  let dropped = 0;
  for (const entry of data) {
    if (!entry || typeof entry.id !== "string") continue;
    if (!isCodexCompatibleModel(entry.id)) {
      dropped += 1;
      continue;
    }
    state.discoveredModels.add(entry.id);
    kept += 1;
  }

  log(
    "agent",
    `Codex: discovered ${kept} chat-compatible models from ${url} (filtered ${dropped} non-chat entries)`,
  );
}
