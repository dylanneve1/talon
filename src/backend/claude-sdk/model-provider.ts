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

const FAMILY_VERSION_PATTERN = /\b([A-Za-z][A-Za-z-]*)\s+(\d+(?:\.\d+)*)\b/;

function toDisplayFamilyName(family: string): string {
  return family
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatResolvedModelLabel(model: ModelInfo): string {
  const match = `${model.displayName} ${model.description ?? ""}`.match(
    FAMILY_VERSION_PATTERN,
  );
  if (match) {
    return `${toDisplayFamilyName(match[1])} ${match[2]}`;
  }

  const familyAlias = model.aliases.find(
    (alias) =>
      !alias.startsWith("claude-") &&
      !alias.endsWith("[1m]") &&
      !/[-.]\d/.test(alias),
  );
  return familyAlias
    ? toDisplayFamilyName(familyAlias)
    : model.displayName.replace(/\s*\([^)]*\)/g, "").trim();
}

function formatCompactLabel(model: ModelInfo): string {
  return formatResolvedModelLabel(model).replace(/\s+\d+(?:\.\d+)*$/, "");
}

function toUnified(model: ModelInfo): UnifiedModelInfo {
  return {
    id: model.id,
    displayName: model.displayName,
    provider: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    selectable: true,
  };
}

/** De-duplicate models by their resolved display label (same logic as getTelegramModelOptions). */
function getUniqueModels(): ModelInfo[] {
  const options: ModelInfo[] = [];
  const seenKeys = new Set<string>();

  for (const model of getModels(PROVIDER_ID)) {
    const key = formatResolvedModelLabel(model).toLowerCase();
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
      formatResolvedModelLabel(current).toLowerCase() ===
      formatResolvedModelLabel(candidate).toLowerCase()
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
): Promise<{ modelButtons: ModelButton[]; modelDetails: string[] }> {
  const options = getUniqueModels();

  const modelButtons: ModelButton[] = options.map((m) => {
    const label = formatCompactLabel(m);
    const selected = isSelectedModel(activeModel, m.id);
    return {
      text: selected ? `\u2713 ${label}` : label,
      callback_data: `settings:model:${m.id}`,
    };
  });

  const resolved = coreResolveModel(activeModel);
  const modelDetails = resolved
    ? [`<i>${resolved.displayName}</i>`]
    : [];

  return { modelButtons, modelDetails };
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
