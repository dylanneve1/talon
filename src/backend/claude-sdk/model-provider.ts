/**
 * Model provider methods for the Claude SDK backend.
 *
 * Implements the optional model methods from QueryBackend by delegating
 * to the core model registry. The Claude SDK exposes a single provider
 * ("anthropic") with models discovered from the SDK at startup.
 */

import {
  getModel,
  getModels,
  resolveModel as coreResolveModel,
  resolveModelId,
} from "../../core/models.js";
import type { ModelInfo } from "../../core/models.js";
import type {
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelButton,
} from "../../core/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const PROVIDER_ID = "anthropic";
const PROVIDER_NAME = "Anthropic";

function toUnified(model: ModelInfo): UnifiedModelInfo {
  return {
    id: model.id,
    displayName: model.displayName,
    provider: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    selectable: true,
  };
}

/** De-duplicate models by displayName (1M variants share a label with their base). */
function getUniqueModels(): ModelInfo[] {
  const options: ModelInfo[] = [];
  const seenKeys = new Set<string>();

  for (const model of getModels(PROVIDER_ID)) {
    const key = model.displayName.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    options.push(model);
  }

  return options;
}

function isSelectedModel(currentModel: string, candidateId: string): boolean {
  const current = coreResolveModel(currentModel);
  const candidate = coreResolveModel(candidateId);
  if (current && candidate) {
    return (
      current.displayName.toLowerCase() === candidate.displayName.toLowerCase()
    );
  }
  return resolveModelId(currentModel) === candidateId;
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function resolveModel(
  query: string,
): Promise<UnifiedModelResolution> {
  const canonicalId = resolveModelId(query);
  const model = getModel(canonicalId);

  if (model) {
    return {
      kind: "exact",
      model: toUnified(model),
      storedValue: model.id,
    };
  }

  // No exact match -- try a substring search across display names and aliases
  const allModels = getModels(PROVIDER_ID);
  const lower = query.toLowerCase();
  const matches = allModels.filter(
    (m) =>
      m.displayName.toLowerCase().includes(lower) ||
      m.aliases.some((a) => a.toLowerCase().includes(lower)),
  );

  if (matches.length === 1) {
    return {
      kind: "exact",
      model: toUnified(matches[0]),
      storedValue: matches[0].id,
    };
  }

  if (matches.length > 1) {
    return { kind: "ambiguous", matches: matches.map(toUnified) };
  }

  return { kind: "missing" };
}

export async function getModelInfo(
  id: string,
): Promise<UnifiedModelInfo | undefined> {
  const canonicalId = resolveModelId(id);
  const model = getModel(canonicalId);
  return model ? toUnified(model) : undefined;
}

export async function getSettingsPresentation(
  activeModel: string,
  callbackPrefix = "settings:model:",
): Promise<{ modelButtons: ModelButton[]; modelDetails: string[] }> {
  const options = getUniqueModels();

  const modelButtons: ModelButton[] = options.map((m) => {
    const selected = isSelectedModel(activeModel, m.id);
    return {
      text: selected ? `\u2713 ${m.displayName}` : m.displayName,
      callback_data: `${callbackPrefix}${m.id}`,
    };
  });

  return { modelButtons, modelDetails: [] };
}

export async function getProviders(): Promise<UnifiedProviderInfo[]> {
  const models = getModels(PROVIDER_ID);
  return [
    {
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      connected: true,
      modelCount: models.length,
    },
  ];
}

export async function getProviderModels(
  providerId: string,
  page = 0,
  pageSize = 20,
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  if (providerId !== PROVIDER_ID) {
    return { models: [], total: 0 };
  }

  const all = getModels(PROVIDER_ID).map(toUnified);
  const start = page * pageSize;
  return {
    models: all.slice(start, start + pageSize),
    total: all.length,
  };
}

export async function listModels(
  filter?: "free" | "all",
): Promise<{ models: UnifiedModelInfo[]; total: number }> {
  // Claude SDK models are all paid — the "free" filter returns nothing.
  if (filter === "free") return { models: [], total: 0 };
  const all = getModels(PROVIDER_ID).map(toUnified);
  return { models: all, total: all.length };
}

export function formatModelError(
  query: string,
  resolution: UnifiedModelResolution,
): string {
  if (resolution.kind === "ambiguous") {
    const names = resolution.matches.map((m) => m.displayName).join(", ");
    return `Ambiguous model "${query}" -- did you mean one of: ${names}?`;
  }

  if (resolution.kind === "missing") {
    const available = getModels(PROVIDER_ID)
      .map((m) => m.displayName)
      .join(", ");
    return `Unknown model "${query}". Available models: ${available}`;
  }

  return `Could not resolve model "${query}".`;
}
