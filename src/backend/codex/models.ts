/**
 * Codex model catalog.
 *
 * Unlike Kilo / OpenCode (which fetch a live provider catalog from a
 * running server), Codex has two effective sources of model truth:
 *
 *   1. **Discovered models** — what OpenAI's `/v1/models` returns for
 *      the configured api key. Source of truth on `auth-mode: api-key`.
 *      Populated asynchronously by `discovery.ts`.
 *   2. **Curated metadata** — the `CODEX_MODELS` table below. Carries
 *      human-friendly displayName, contextWindow, reasoning flag, and
 *      the all-important `apiKeyOnly` marker used by the handler's
 *      recovery ladder for ChatGPT-OAuth users. Also serves as the
 *      fallback catalog when discovery isn't possible (OAuth mode) or
 *      hasn't yet completed.
 *
 * `getEffectiveModels()` merges these: it returns curated entries for
 * known ids and synthesises minimal entries for discovered ids the
 * curated table doesn't know about (so a future `gpt-6` would show up
 * in the picker as soon as it lands at OpenAI, no Talon release
 * required).
 *
 * Reasoning-effort suffixes (`gpt-5-codex-high`, etc.) go through
 * Codex's `modelReasoningEffort` thread option rather than baked into
 * the model id, so we keep this list short.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
} from "../../core/types.js";
import { awaitDiscovery, hasAttemptedDiscovery } from "./discovery.js";
import { getState } from "./state.js";

/**
 * Codex-specific model metadata extension.
 *
 * The Codex CLI accepts a fixed set of model strings, but which ones
 * actually resolve depends on the auth mode in use. `apiKeyOnly: true`
 * marks models that the OpenAI API rejects with a 400 when called from
 * a ChatGPT-OAuth account (`auth_mode: "chatgpt"` in `~/.codex/auth.json`).
 * The handler's recovery ladder reads this flag.
 */
export interface CodexModelInfo extends UnifiedModelInfo {
  /** True if this model requires API-key billing (not available on ChatGPT OAuth). */
  apiKeyOnly?: boolean;
}

/**
 * Curated metadata for models we recognise.
 *
 * Order matters: `getSettingsPresentation` lists curated models in
 * this order, and `gpt-5.5` is intentionally first because it's the
 * broadest-access flagship (works on both auth modes) — the safe
 * default for Talon-on-Codex deployments where the operator hasn't
 * explicitly picked a model.
 *
 * Discovered-but-not-curated ids are appended at the end (synthesised
 * with minimal metadata), so the curated entries always render first.
 */
export const CODEX_MODELS: CodexModelInfo[] = [
  {
    id: "gpt-5.5",
    displayName: "GPT-5.5",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5",
    displayName: "GPT-5",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
  },
  {
    id: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 400_000,
    apiKeyOnly: true,
  },
  {
    id: "o4-mini",
    displayName: "o4-mini",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 128_000,
  },
];

/**
 * True when the given model id is in the curated catalog AND flagged
 * as api-key-only. Returns `false` for unknown models — the caller
 * should not over-correct on unrecognised inputs.
 */
export function isCodexApiKeyOnlyModel(id: string): boolean {
  return CODEX_MODELS.some((m) => m.id === id && m.apiKeyOnly === true);
}

/**
 * Return a chatgpt-OAuth-compatible fallback for an api-key-only model.
 * Returns `undefined` when the model isn't recognised as api-key-only
 * (caller can skip the fallback path) or when no compatible fallback
 * exists. Currently the only api-key-only entry is `gpt-5-codex`; this
 * function points it at `gpt-5.5` as the broadest-access flagship.
 */
export function chatGptFallbackFor(id: string): string | undefined {
  if (!isCodexApiKeyOnlyModel(id)) return undefined;
  return "gpt-5.5";
}

/**
 * Synthesize a minimal `CodexModelInfo` for a model id discovered via
 * `/v1/models` or the Codex CLI cache file that isn't in the curated
 * table. Pulls the display name + context window from the discovered
 * metadata map when present (OAuth cache-file path); otherwise
 * derives a sensible display name from the id (api-key /v1/models
 * path is sparse).
 *
 * Pulled out for unit-testability.
 */
export function synthesizeUnknownModel(id: string): CodexModelInfo {
  // Reasoning flag: `o3*` / `o4*` and any `*-codex` are reasoning models.
  // Default to false for anything else (e.g. legacy gpt-4*).
  const reasoning = /^o[3-9]|-codex(\b|$)/i.test(id);
  const meta = getState().discoveredModelMetadata.get(id);
  return {
    id,
    displayName: meta?.displayName || prettifyId(id),
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning,
    ...(meta?.contextWindow ? { contextWindow: meta.contextWindow } : {}),
  };
}

function prettifyId(id: string): string {
  // Capitalise `gpt`, leave reasoning prefixes (`o3-`, `o4-`) lowercase
  // (matches OpenAI's house style), preserve everything else verbatim.
  return id.replace(/^gpt-/i, "GPT-").replace(/^chatgpt-/i, "ChatGPT-");
}

/**
 * Return the effective Codex model catalog: curated entries plus any
 * discovered-but-not-curated ids.
 *
 * Semantics:
 *   - When discovery has completed AND returned a non-empty set
 *     (typical `auth-mode: api-key`), the union is
 *     `curated ∩ discovered ∪ (discovered − curated)`, i.e. curated
 *     entries hide if the api key can't see them, and brand-new ids
 *     appear with synthesised metadata. The order is curated-first
 *     (in declaration order) then discovered-only (in iteration order).
 *   - When discovery returned an empty set (OAuth mode, or no api key,
 *     or transient failure), the catalog falls back to the full
 *     curated list.
 *   - The `apiKeyOnly` marker is preserved from curated metadata even
 *     when the model is also discovered — the recovery ladder still
 *     needs to know to swap it out on OAuth retries.
 */
export function getEffectiveModels(): CodexModelInfo[] {
  const state = getState();
  const discovered = state.discoveredModels;

  // Empty discovered set → fall back to curated list. This covers
  // OAuth users (where we deliberately never populate `discoveredModels`),
  // pre-discovery first paints, and transient `/v1/models` failures.
  if (discovered.size === 0) return [...CODEX_MODELS];

  const result: CodexModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of CODEX_MODELS) {
    if (!discovered.has(m.id)) continue;
    result.push(m);
    seen.add(m.id);
  }
  for (const id of discovered) {
    if (seen.has(id)) continue;
    result.push(synthesizeUnknownModel(id));
  }
  return result;
}

/**
 * Resolve a user query string against the Codex model catalog.
 *
 * Matches by exact id first, then case-insensitive prefix on id or
 * display name across the *effective* (merged) catalog. Returns
 * ambiguous when multiple models match. Async so it can `awaitDiscovery`
 * before searching — without that, a `/model gpt-6` query right after
 * backend startup would miss a model the key actually has.
 */
export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const q = query.trim();
  if (!q) return { kind: "missing" };

  // Wait for any in-flight discovery so a brand-new model id can resolve
  // on the first try. Soft timeout keeps slash-command latency tight.
  await awaitDiscovery();
  const catalog = getEffectiveModels();

  const exact = catalog.find((m) => m.id === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  const qLower = q.toLowerCase();
  const matches = catalog.filter(
    (m) =>
      m.id.toLowerCase().startsWith(qLower) ||
      m.displayName.toLowerCase().startsWith(qLower),
  );

  if (matches.length === 0) return { kind: "missing" };
  if (matches.length === 1) {
    return { kind: "exact", model: matches[0], storedValue: matches[0].id };
  }
  return { kind: "ambiguous", matches };
}

/** Look up a model by stored id, consulting the effective catalog. */
export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  await awaitDiscovery();
  return getEffectiveModels().find((m) => m.id === id);
}

/**
 * Quick-pick buttons for the `/settings` model picker.
 *
 * Awaits in-flight discovery (3s soft timeout via `awaitDiscovery`)
 * so the first picker render after a backend switch gets the dynamic
 * catalog rather than the curated stub. Subsequent calls short-circuit
 * because the promise has already settled.
 */
export async function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): Promise<ModelPickerResult> {
  // Soft-wait for discovery so the catalog is populated before render.
  // If discovery already finished (success or failure), this returns
  // immediately — no extra latency on the steady-state path.
  if (!hasAttemptedDiscovery()) {
    await awaitDiscovery();
  }

  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const catalog = getEffectiveModels();

  const modelButtons: ModelButton[] = catalog.map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  const active = catalog.find((m) => m.id === activeModel);
  const modelDetails: string[] = [];
  if (active) {
    const ctx = active.contextWindow
      ? ` — ${Math.round(active.contextWindow / 1000)}k ctx`
      : "";
    modelDetails.push(`Active: ${active.displayName} (${active.id})${ctx}`);
  }
  const state = getState();
  const sourceLabel =
    state.discoveredModels.size > 0
      ? `${catalog.length} models (${state.discoveredModels.size} discovered)`
      : `${catalog.length} models (curated)`;
  modelDetails.push(`Backend: Codex — ${sourceLabel}`);

  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: catalog.length,
  };
}

/** List Codex's providers (one — OpenAI). */
export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  await awaitDiscovery();
  const catalog = getEffectiveModels();
  return [
    {
      id: "openai",
      name: "OpenAI",
      connected: true,
      modelCount: catalog.length,
    },
  ];
}

/** List models for a provider (paginated). */
export async function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 50,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  if (providerId !== "openai") return { models: [], total: 0 };
  await awaitDiscovery();
  const catalog = getEffectiveModels();
  const start = (page - 1) * pageSize;
  return {
    models: catalog.slice(start, start + pageSize),
    total: catalog.length,
  };
}

/** Format a human-readable error for an unresolvable model query. */
export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches.map((m) => `\`${m.id}\``).join(", ");
    return `Multiple Codex models match \`${query}\`: ${list}. Pick one.`;
  }
  // Show the effective catalog (not just curated) so the hint reflects
  // what the operator's api key can actually call.
  const catalog = getEffectiveModels();
  return (
    `No Codex model matches \`${query}\`. ` +
    `Available: ${catalog.map((m) => m.id).join(", ")}.`
  );
}

/** Filter the catalog by a coarse-grained tag. */
export async function listModels(
  filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  // None of Codex's official models are free; the `free` filter
  // returns an empty list so the `/model free` slash-command produces
  // an honest "(no free models)" message.
  if (filter === "free") {
    return { models: [], total: 0 };
  }
  await awaitDiscovery();
  const catalog = getEffectiveModels();
  return { models: catalog, total: catalog.length };
}
