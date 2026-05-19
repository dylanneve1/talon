/**
 * Endpoint-model discovery for the OpenAI Agents backend.
 *
 * Why this is a separate module
 * ─────────────────────────────
 *
 * The backend is provider-agnostic — it speaks to any OpenAI-compatible
 * endpoint (OpenAI itself, OpenRouter, Azure, Ollama, LiteLLM, vLLM…).
 * Each endpoint advertises its catalog via `GET /models`. The shape is
 * loose: OpenRouter ships `top_provider.context_length` and
 * `pricing.prompt`; vLLM ships only `context_length`; OpenAI's response
 * is sparse; Ollama is bare. We grab whatever's present, drop the rest,
 * and store it in `state.endpointModels` for the resolver + picker.
 *
 * Two ergonomic requirements drive the design:
 *
 *   1. **First /model after a backend switch must show the catalog.**
 *      The original flow was fire-and-forget — if the user opened the
 *      menu while the `/models` HTTP call was still in flight, they saw
 *      an empty catalog. We now expose the discovery promise via
 *      `awaitDiscovery(timeoutMs)` so the menu can wait briefly (3s
 *      default) before snapshotting.
 *
 *   2. **Bootstrap must not block on the network.** Calling code uses
 *      `startDiscovery()` from `init.ts` which kicks off the fetch and
 *      stashes the promise on state. Bootstrap proceeds immediately;
 *      the catalog populates in the background.
 *
 * The module is self-contained: it talks to the network, mutates only
 * `state.endpointModels` / `state.discoveryPromise` / `state.discoveryAt`,
 * and exposes no side-effects beyond that.
 */

import { log, logDebug } from "../../util/log.js";
import { getState, type EndpointModelCapabilities } from "./state.js";

/**
 * Shape of one entry returned by an OpenAI-compatible `/models`
 * endpoint. Optional everywhere — providers fill different subsets.
 *
 * `top_provider.context_length` is OpenRouter's escape hatch when the
 * inner model exposes a larger window than the gateway can serve.
 * `pricing.prompt === "0"` (or numeric `0`) is how OpenRouter flags
 * free-tier models; other providers don't use this field.
 */
interface EndpointModelEntry {
  id?: string;
  /** OpenRouter + most providers — human display name. */
  name?: string;
  /** Gemini's OpenAI-compatible endpoint uses this instead of `name`. */
  display_name?: string;
  context_length?: number;
  top_provider?: { context_length?: number };
  pricing?: { prompt?: string | number; completion?: string | number };
}

/** Default soft timeout when callers await an in-flight discovery. */
const DEFAULT_AWAIT_TIMEOUT_MS = 3_000;

/** Hard timeout for a single `/models` HTTP fetch. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Kick off endpoint discovery as a fire-and-forget background fetch.
 *
 * Stashes the in-flight Promise on `state.discoveryPromise` so callers
 * that need a populated catalog can `await awaitDiscovery()` instead
 * of racing the network. Idempotent: a second call while one is in
 * flight is a no-op (returns the existing promise).
 *
 * Failures are logged at debug and never throw — the catalog stays
 * empty, the resolver falls through to passthrough, and the next
 * `/models` call (e.g. a manual `refreshDiscovery`) gets a fresh
 * chance.
 */
export function startDiscovery(
  baseURL: string,
  apiKey: string | undefined,
): Promise<void> {
  const state = getState();
  if (state.discoveryPromise) return state.discoveryPromise;

  const promise = fetchEndpointModels(baseURL, apiKey)
    .then(() => {
      state.discoveryAt = Date.now();
    })
    .catch((err) => {
      logDebug(
        "agent",
        `Endpoint model enrichment skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      // Clear the promise reference so a subsequent `refreshDiscovery`
      // can kick off a new fetch instead of being short-circuited.
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
 * Force a fresh `/models` fetch even when one was attempted before.
 *
 * Useful when the operator changes the endpoint at runtime or wants
 * to retry after a transient failure. Returns the new promise so
 * callers can await if they want; safe to fire-and-forget.
 */
export function refreshDiscovery(
  baseURL: string,
  apiKey: string | undefined,
): Promise<void> {
  const state = getState();
  // Drop the cached promise so `startDiscovery` doesn't short-circuit.
  state.discoveryPromise = null;
  return startDiscovery(baseURL, apiKey);
}

/**
 * Whether the catalog has at least one enriched entry. Used by the
 * picker to decide whether awaiting in-flight discovery is worthwhile
 * (already-populated catalogs short-circuit the wait).
 */
export function hasDiscoveredCatalog(): boolean {
  return getState().endpointModels.size > 0;
}

/**
 * Query the OpenAI-compatible `/models` endpoint and populate
 * `state.endpointModels` with the advertised metadata.
 *
 * Tolerant by design: missing fields are skipped, malformed entries
 * are dropped, and a non-2xx response throws so the caller can decide
 * whether to log-and-forget or retry. Entries with zero discovered
 * capabilities are dropped — they'd render as meaningless rows in
 * /status without giving the picker anything useful — but the
 * resolver still accepts unknown ids as bare passthroughs, so power
 * users can target an id `/models` didn't advertise.
 */
export async function fetchEndpointModels(
  baseURL: string,
  apiKey: string | undefined,
): Promise<void> {
  const url = baseURL.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`/models returned ${res.status}`);
  }
  const json = (await res.json()) as { data?: EndpointModelEntry[] };
  const data = Array.isArray(json?.data) ? json.data : [];

  const state = getState();
  let enriched = 0;
  for (const entry of data) {
    if (!entry || typeof entry.id !== "string") continue;
    const id = normaliseModelId(entry.id);
    const caps = extractCapabilities(entry);
    // Always record the id — sparse-response endpoints (OpenAI's
    // /v1/models, NVIDIA NIM, bare Ollama, some Azure deployments)
    // advertise just `id` with no context_length / pricing / display
    // name, but the picker still needs to list them. Storing with an
    // empty caps record gives the picker something to render; caps is
    // purely additive metadata.
    state.endpointModels.set(id, caps);
    if (Object.keys(caps).length > 0) enriched += 1;
  }

  log("agent", `OpenAI Agents: enriched ${enriched} models from ${url}`);
}

/**
 * Normalise the id Talon stores + sends back to the endpoint.
 *
 * Gemini's OpenAI-compatible `/models` returns ids like
 * `models/gemini-2.5-flash`, but the chat-completions route accepts
 * either form. Stripping the `models/` prefix keeps the picker label
 * clean and lets the flat-id provider-inference table in `models.ts`
 * bucket the entry under Google instead of treating "models" as a
 * provider name from the slash split. Other endpoints aren't
 * affected — the prefix only appears on Gemini.
 */
function normaliseModelId(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

/**
 * Derive `EndpointModelCapabilities` from a `/models` entry. Pulled
 * out for unit-testability — the field-shape decisions are the most
 * provider-specific part of discovery.
 */
export function extractCapabilities(
  entry: EndpointModelEntry,
): EndpointModelCapabilities {
  const caps: EndpointModelCapabilities = {};
  const ctx =
    typeof entry.context_length === "number"
      ? entry.context_length
      : typeof entry.top_provider?.context_length === "number"
        ? entry.top_provider.context_length
        : undefined;
  if (ctx && ctx > 0) caps.contextWindow = ctx;
  // `name` (OpenRouter, most providers) and `display_name` (Gemini)
  // both mean the human label. Prefer `name` when both are present;
  // fall back to `display_name` so Gemini gets nice labels too.
  const displayName =
    (typeof entry.name === "string" && entry.name) ||
    (typeof entry.display_name === "string" && entry.display_name) ||
    undefined;
  if (displayName) caps.displayName = displayName;
  if (isFreePrompt(entry.pricing?.prompt)) {
    caps.free = true;
  }
  return caps;
}

/**
 * Whether an endpoint's pricing.prompt value means "free".
 *
 * OpenRouter publishes pricing as decimal strings ("0", "0.0000003",
 * "0.00001") OR as JSON numbers depending on transport. "0" with any
 * format (numeric, string, "0.0", "0e0") is treated as free; anything
 * else is treated as paid.
 *
 * We deliberately don't probe `pricing.completion`: every free-tier
 * OpenRouter model has both prompt and completion priced at 0, and a
 * model with prompt > 0 isn't free even if completion is 0 (which
 * doesn't actually happen, but be principled).
 */
function isFreePrompt(value: string | number | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === "number") return value === 0;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n === 0;
}
