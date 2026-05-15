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
} from "../../core/types.js";

/** Models available through the Codex CLI. */
export const CODEX_MODELS: UnifiedModelInfo[] = [
  {
    id: "gpt-5-codex",
    displayName: "GPT-5 Codex",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 200_000,
  },
  {
    id: "gpt-5",
    displayName: "GPT-5",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 200_000,
  },
  {
    id: "gpt-5-mini",
    displayName: "GPT-5 Mini",
    provider: "openai",
    providerName: "OpenAI",
    selectable: true,
    reasoning: true,
    contextWindow: 200_000,
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

/** Quick-pick buttons for the `/settings` model picker. */
export function getSettingsPresentation(
  activeModel: string,
  callbackPrefix = "settings:model:",
): { modelButtons: ModelButton[]; modelDetails: string[] } {
  const modelButtons: ModelButton[] = CODEX_MODELS.map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  const modelDetails = CODEX_MODELS.map((m) => {
    const flags: string[] = [];
    if (m.reasoning) flags.push("reasoning");
    if (m.contextWindow) flags.push(`${m.contextWindow / 1000}k ctx`);
    return `**${m.displayName}** (${m.id}) — ${flags.join(" · ")}`;
  });

  return { modelButtons, modelDetails };
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
