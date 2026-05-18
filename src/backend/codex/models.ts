/**
 * Codex model catalog.
 *
 * Unlike Kilo / OpenCode (which fetch a live provider catalog from a
 * running server) and Claude SDK (which queries the SDK's model
 * registry), Codex ships with a fixed-ish set of models hardcoded in
 * the CLI. The set we expose here mirrors what `codex --help` lists
 * and what OpenAI's docs document as Codex-supported.
 *
 * Reasoning-effort suffixes (`gpt-5-codex-high`, etc.) are pushed
 * through Codex's `modelReasoningEffort` thread option rather than
 * baked into the model id, so we keep this list short.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
  ModelPickerOptions,
  ModelPickerResult,
} from "../../core/types.js";

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
 * Models available through the Codex CLI.
 *
 * Order matters: `getSettingsPresentation` lists models in this order,
 * and `gpt-5.5` is intentionally first because it's the broadest-access
 * model (works on both auth modes) — it's the safe default for
 * Talon-on-Codex deployments where the operator hasn't explicitly
 * picked a model.
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
 * True when the given model id is in the catalog AND flagged as
 * api-key-only. Returns `false` for unknown models — the caller should
 * not over-correct on unrecognised inputs.
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
 * Resolve a user query string against the Codex model catalog.
 *
 * Matches by exact id first, then case-insensitive prefix on id or
 * display name. Returns ambiguous when multiple models match.
 */
export function resolveModel(query: string): UnifiedModelResolution {
  const q = query.trim();
  if (!q) return { kind: "missing" };

  // Exact-id match
  const exact = CODEX_MODELS.find((m) => m.id === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  // Case-insensitive prefix match on id or displayName
  const qLower = q.toLowerCase();
  const matches = CODEX_MODELS.filter(
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

/** Look up a model by stored id. */
export function getModelInfo(id: string): UnifiedModelInfo | undefined {
  return CODEX_MODELS.find((m) => m.id === id);
}

/**
 * Quick-pick buttons for the `/settings` model picker. Codex ships a
 * small fixed catalog so pagination + the free-tier filter are
 * no-ops; we satisfy the contract by returning fixed metadata.
 */
export function getSettingsPresentation(
  activeModel: string,
  options: ModelPickerOptions = {},
): ModelPickerResult {
  const callbackPrefix = options.callbackPrefix ?? "settings:model:";
  const modelButtons: ModelButton[] = CODEX_MODELS.map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  const active = CODEX_MODELS.find((m) => m.id === activeModel);
  const modelDetails: string[] = [];
  if (active) {
    const ctx = active.contextWindow
      ? ` — ${Math.round(active.contextWindow / 1000)}k ctx`
      : "";
    modelDetails.push(`Active: ${active.displayName} (${active.id})${ctx}`);
  }
  modelDetails.push(`Backend: Codex — ${CODEX_MODELS.length} models`);

  return {
    modelButtons,
    modelDetails,
    view: "models",
    page: 1,
    totalPages: 1,
    filter: "all",
    freeCount: 0,
    totalCount: CODEX_MODELS.length,
  };
}

/** List Codex's providers (one — OpenAI). */
export function getProviders(): UnifiedProviderInfo[] {
  return [
    {
      id: "openai",
      name: "OpenAI",
      connected: true,
      modelCount: CODEX_MODELS.length,
    },
  ];
}

/** List models for a provider (paginated). */
export function getProviderModels(
  providerId: string,
  page = 1,
  pageSize = 50,
): { models: UnifiedModelInfo[]; total: number } {
  if (providerId !== "openai") return { models: [], total: 0 };
  const start = (page - 1) * pageSize;
  return {
    models: CODEX_MODELS.slice(start, start + pageSize),
    total: CODEX_MODELS.length,
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
  return (
    `No Codex model matches \`${query}\`. ` +
    `Available: ${CODEX_MODELS.map((m) => m.id).join(", ")}.`
  );
}

/** Filter the catalog by a coarse-grained tag. */
export function listModels(filter?: "free" | "all"): {
  models: UnifiedModelInfo[];
  total: number;
} {
  // None of Codex's official models are free; the `free` filter
  // returns an empty list so the `/model free` slash-command produces
  // an honest "(no free models)" message.
  if (filter === "free") {
    return { models: [], total: 0 };
  }
  return { models: CODEX_MODELS, total: CODEX_MODELS.length };
}
