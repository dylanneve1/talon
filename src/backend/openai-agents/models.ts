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
import { getState } from "./state.js";

/**
 * Build a `UnifiedModelInfo` for an arbitrary model id when the
 * backend is talking to a custom OpenAI-compatible endpoint.
 *
 * If `init.ts`'s `fetchEndpointModels()` has finished, we enrich the
 * passthrough with whatever the endpoint advertised (real context
 * window, display name, free flag). Otherwise we fall back to a bare
 * passthrough — the id verbatim, no capabilities — so /status and
 * /settings stay rendererable even before the catalog fetch lands.
 */
function makePassthroughModel(id: string): UnifiedModelInfo {
  const caps = getState().endpointModels.get(id);
  return {
    id,
    displayName: caps?.displayName ?? id,
    provider: "openai-compatible",
    providerName: "OpenAI-compatible endpoint",
    selectable: true,
    reasoning: false,
    ...(caps?.contextWindow ? { contextWindow: caps.contextWindow } : {}),
    ...(caps?.free ? { free: true } : {}),
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
  const merged = mergedCatalog();
  const start = (page - 1) * pageSize;
  return {
    models: merged.slice(start, start + pageSize),
    total: merged.length,
  };
}

/**
 * Return the visible model catalog: the built-in OpenAI catalog plus
 * anything the remote endpoint advertised via `GET /models` (see
 * `init.ts#fetchEndpointModels`). Built-ins win for shared ids so we
 * don't trample the OpenAI display names with whatever raw id the
 * proxy returns.
 */
function mergedCatalog(): UnifiedModelInfo[] {
  const builtIns = new Map<string, UnifiedModelInfo>();
  for (const m of OPENAI_AGENTS_MODELS) builtIns.set(m.id, m);

  const endpoint = getState().endpointModels;
  const out: UnifiedModelInfo[] = [...OPENAI_AGENTS_MODELS];
  for (const [id, caps] of endpoint) {
    if (builtIns.has(id)) continue;
    out.push({
      id,
      displayName: caps.displayName ?? id,
      provider: "openai-compatible",
      providerName: "OpenAI-compatible endpoint",
      selectable: true,
      reasoning: false,
      ...(caps.contextWindow ? { contextWindow: caps.contextWindow } : {}),
      ...(caps.free ? { free: true } : {}),
    });
  }
  return out;
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
  const merged = mergedCatalog();
  if (filter === "free") {
    const free = merged.filter((m) => m.free === true);
    return { models: free, total: free.length };
  }
  return { models: merged, total: merged.length };
}
