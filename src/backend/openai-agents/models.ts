/**
 * OpenAI Agents backend model catalog.
 *
 * The Agents SDK speaks to OpenAI's Responses (or Chat Completions)
 * API and accepts any model identifier the endpoint exposes. The
 * built-in catalog covers the OpenAI-native models; when a custom
 * `openaiBaseUrl` is configured (OpenRouter, Azure, Ollama, etc.),
 * arbitrary model ids are accepted as passthrough so users can target
 * e.g. `meta-llama/llama-3.3-70b-instruct` without us maintaining a
 * separate catalog per third-party provider.
 *
 * Note: `gpt-5-codex` is intentionally NOT in this catalog. That
 * model is exposed via the Codex CLI only, not the public Responses
 * API. Users who want `gpt-5-codex` should use the `codex` backend.
 */

import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
} from "../../core/types.js";
import { getOpenAIBaseUrl } from "./init.js";

/**
 * Build a synthetic `UnifiedModelInfo` for an arbitrary model id when
 * the backend is talking to a custom OpenAI-compatible endpoint.
 *
 * We don't know the model's capabilities or context window from the
 * id alone, so the display name is the id verbatim and capability
 * flags stay false. This is purely a passthrough.
 */
function makePassthroughModel(id: string): UnifiedModelInfo {
  return {
    id,
    displayName: id,
    provider: "openai-compatible",
    providerName: "OpenAI-compatible endpoint",
    selectable: true,
    reasoning: false,
  };
}

/** Models available through the OpenAI Agents SDK. */
export const OPENAI_AGENTS_MODELS: UnifiedModelInfo[] = [
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
 * Resolve a user query against the catalog. Exact-id match first,
 * then case-insensitive prefix on id or display name; ambiguous when
 * multiple match.
 *
 * When a custom `openaiBaseUrl` is configured the catalog isn't
 * authoritative — anything the user types is passed through to the
 * endpoint verbatim. The prefix-matching pass still runs first so
 * `gpt-5` resolves cleanly on OpenAI-compatible proxies that happen
 * to mirror OpenAI's namespace.
 */
export function resolveModel(query: string): UnifiedModelResolution {
  const q = query.trim();
  if (!q) return { kind: "missing" };

  const exact = OPENAI_AGENTS_MODELS.find((m) => m.id === q);
  if (exact) return { kind: "exact", model: exact, storedValue: exact.id };

  const qLower = q.toLowerCase();
  const matches = OPENAI_AGENTS_MODELS.filter(
    (m) =>
      m.id.toLowerCase().startsWith(qLower) ||
      m.displayName.toLowerCase().startsWith(qLower),
  );

  if (matches.length === 1) {
    return { kind: "exact", model: matches[0], storedValue: matches[0].id };
  }
  if (matches.length > 1) {
    return { kind: "ambiguous", matches };
  }

  // No catalog hit. If a custom endpoint is configured, accept the
  // raw id as a passthrough — third-party endpoints (OpenRouter,
  // Azure, Ollama, LiteLLM) use namespaces we don't track.
  if (getOpenAIBaseUrl()) {
    const passthrough = makePassthroughModel(q);
    return { kind: "exact", model: passthrough, storedValue: passthrough.id };
  }

  return { kind: "missing" };
}

/** Look up a model by stored id. */
export function getModelInfo(id: string): UnifiedModelInfo | undefined {
  const found = OPENAI_AGENTS_MODELS.find((m) => m.id === id);
  if (found) return found;
  // Custom-endpoint passthrough — surface the id back so /settings can
  // render something instead of "unknown model".
  if (getOpenAIBaseUrl()) return makePassthroughModel(id);
  return undefined;
}

/** Quick-pick buttons for the `/settings` model picker. */
export function getSettingsPresentation(
  activeModel: string,
  callbackPrefix = "settings:model:",
): { modelButtons: ModelButton[]; modelDetails: string[] } {
  const modelButtons: ModelButton[] = OPENAI_AGENTS_MODELS.map((m) => ({
    text: `${m.id === activeModel ? "● " : ""}${m.displayName}`,
    callback_data: `${callbackPrefix}${m.id}`,
  }));

  const modelDetails = OPENAI_AGENTS_MODELS.map((m) => {
    const flags: string[] = [];
    if (m.reasoning) flags.push("reasoning");
    if (m.contextWindow) flags.push(`${m.contextWindow / 1000}k ctx`);
    return `**${m.displayName}** (${m.id}) — ${flags.join(" · ")}`;
  });

  return { modelButtons, modelDetails };
}

/** OpenAI is the sole provider for this backend. */
export function getProviders(): UnifiedProviderInfo[] {
  return [
    {
      id: "openai",
      name: "OpenAI",
      connected: true,
      modelCount: OPENAI_AGENTS_MODELS.length,
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
    models: OPENAI_AGENTS_MODELS.slice(start, start + pageSize),
    total: OPENAI_AGENTS_MODELS.length,
  };
}

/** Format a human-readable error for an unresolvable model query. */
export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const list = resolution.matches.map((m) => `\`${m.id}\``).join(", ");
    return `Multiple OpenAI Agents models match \`${query}\`: ${list}. Pick one.`;
  }
  if (getOpenAIBaseUrl()) {
    return (
      `No catalog entry matches \`${query}\`. A custom \`openaiBaseUrl\` is set, ` +
      `so any id your endpoint accepts is valid — set \`model\` directly in talon.json.`
    );
  }
  return (
    `No OpenAI Agents model matches \`${query}\`. ` +
    `Available: ${OPENAI_AGENTS_MODELS.map((m) => m.id).join(", ")}.`
  );
}

/** Filter the catalog by a coarse-grained tag. */
export function listModels(filter?: "free" | "all"): {
  models: UnifiedModelInfo[];
  total: number;
} {
  // No free models on the OpenAI Responses API.
  if (filter === "free") return { models: [], total: 0 };
  return {
    models: OPENAI_AGENTS_MODELS,
    total: OPENAI_AGENTS_MODELS.length,
  };
}
