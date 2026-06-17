/**
 * OpenCode model resolution — query parsing, fuzzy matching, provider-id guessing,
 * collision-aware selection values, and the `resolveOpenCodeModelInput`
 * resolver that classifies a query as exact / ambiguous / missing.
 */

import type {
  OpenCodeModelCatalog,
  OpenCodeModelCatalogEntry,
  OpenCodeModelResolution,
} from "./types.js";
import { getOpenCodeModelCatalog, sortCatalogModels } from "./catalog.js";

const PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/gpt|^o[134]/, "openai"],
  [/gemini/, "google"],
  [/claude/, "anthropic"],
];

const BUCKET_PRIORITY: Record<string, number> = {
  connected: 0,
  configured: 1,
  available: 2,
  all: 3,
};

export function guessProviderID(modelID: string): string {
  const lower = modelID.toLowerCase();
  return PROVIDER_PATTERNS.find(([re]) => re.test(lower))?.[1] ?? "opencode";
}

export function getBucketPriority(name: string): number {
  return BUCKET_PRIORITY[name] ?? 4;
}

export function normalizeModelLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, "").replace(/\s+/g, "-");
}

export function parseOpenCodeModelQuery(value: string): {
  providerQuery?: string;
  modelQuery: string;
} {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  const colonIndex = trimmed.indexOf(":");
  const separatorIndex =
    slashIndex > 0 && colonIndex > 0
      ? Math.min(slashIndex, colonIndex)
      : Math.max(slashIndex, colonIndex);

  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return { modelQuery: trimmed };
  }

  const providerQuery = trimmed.slice(0, separatorIndex).trim();
  const modelQuery = trimmed.slice(separatorIndex + 1).trim();
  if (!providerQuery || !modelQuery) {
    return { modelQuery: trimmed };
  }

  return { providerQuery, modelQuery };
}

function matchesLookupQuery(value: string, normalizedQuery: string): boolean {
  return (
    value === normalizedQuery ||
    value.startsWith(normalizedQuery) ||
    value.includes(normalizedQuery)
  );
}

function matchesProviderQuery(
  model: OpenCodeModelCatalogEntry,
  normalizedProviderQuery: string,
): boolean {
  const providerId = normalizeModelLookup(model.providerID);
  const providerName = normalizeModelLookup(model.providerName);
  return (
    matchesLookupQuery(providerId, normalizedProviderQuery) ||
    matchesLookupQuery(providerName, normalizedProviderQuery)
  );
}

function hasProviderExactMatch(
  model: OpenCodeModelCatalogEntry,
  normalizedProviderQuery: string,
): boolean {
  return (
    normalizeModelLookup(model.providerID) === normalizedProviderQuery ||
    normalizeModelLookup(model.providerName) === normalizedProviderQuery
  );
}

function hasModelIDCollision(
  catalog: OpenCodeModelCatalog,
  model: OpenCodeModelCatalogEntry,
): boolean {
  return catalog.models.some(
    (candidate) =>
      candidate.id === model.id && candidate.providerID !== model.providerID,
  );
}

export function getOpenCodeModelSelectionValue(
  model: OpenCodeModelCatalogEntry,
  catalog: OpenCodeModelCatalog,
): string {
  return hasModelIDCollision(catalog, model)
    ? `${model.providerID}/${model.id}`
    : model.id;
}

function getSearchCandidates(
  query: string,
  catalog: OpenCodeModelCatalog,
): Array<OpenCodeModelCatalogEntry> {
  const { providerQuery, modelQuery } = parseOpenCodeModelQuery(query);
  const normalizedModel = normalizeModelLookup(modelQuery);
  const normalizedProvider = providerQuery
    ? normalizeModelLookup(providerQuery)
    : undefined;
  const matches = catalog.models.filter((model) => {
    const modelMatches =
      matchesLookupQuery(normalizeModelLookup(model.id), normalizedModel) ||
      matchesLookupQuery(normalizeModelLookup(model.name), normalizedModel);
    if (!modelMatches) return false;
    return normalizedProvider
      ? matchesProviderQuery(model, normalizedProvider)
      : true;
  });

  return matches.sort((left, right) => {
    if (normalizedProvider) {
      const leftProviderExact = hasProviderExactMatch(left, normalizedProvider);
      const rightProviderExact = hasProviderExactMatch(
        right,
        normalizedProvider,
      );
      if (leftProviderExact !== rightProviderExact) {
        return leftProviderExact ? -1 : 1;
      }
    }

    const leftExact =
      normalizeModelLookup(left.id) === normalizedModel ||
      normalizeModelLookup(left.name) === normalizedModel;
    const rightExact =
      normalizeModelLookup(right.id) === normalizedModel ||
      normalizeModelLookup(right.name) === normalizedModel;
    if (leftExact !== rightExact) return leftExact ? -1 : 1;
    return sortCatalogModels(left, right);
  });
}

export function resolveOpenCodeModelInput(
  query: string,
  catalog: OpenCodeModelCatalog,
): OpenCodeModelResolution {
  const matches = getSearchCandidates(query, catalog);
  if (matches.length === 0) return { kind: "missing", matches: [] };

  const bestMatch = matches[0];
  const { providerQuery, modelQuery } = parseOpenCodeModelQuery(query);
  const normalizedModel = normalizeModelLookup(modelQuery);
  const normalizedProvider = providerQuery
    ? normalizeModelLookup(providerQuery)
    : undefined;
  const exactMatches = matches.filter((model) => {
    const exactModelMatch =
      normalizeModelLookup(model.id) === normalizedModel ||
      normalizeModelLookup(model.name) === normalizedModel;
    if (!exactModelMatch) return false;

    return normalizedProvider
      ? hasProviderExactMatch(model, normalizedProvider)
      : true;
  });
  const selectableExactMatches = exactMatches.filter(
    (model) => model.selectable,
  );

  if (exactMatches.length === 1) {
    return { kind: "exact", model: exactMatches[0] };
  }

  if (selectableExactMatches.length === 1) {
    return { kind: "exact", model: selectableExactMatches[0] };
  }

  if (matches.length === 1 && bestMatch) {
    return { kind: "exact", model: bestMatch };
  }

  return { kind: "ambiguous", matches: matches.slice(0, 8) };
}

export async function getOpenCodeModelInfo(
  modelID: string,
): Promise<OpenCodeModelCatalogEntry | undefined> {
  const catalog = await getOpenCodeModelCatalog();
  const resolution = resolveOpenCodeModelInput(modelID, catalog);
  if (resolution.kind === "missing") return undefined;
  return resolution.kind === "exact" ? resolution.model : resolution.matches[0];
}
