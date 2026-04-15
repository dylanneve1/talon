/**
 * OpenCode model catalog — types, resolution, formatting, and cache.
 *
 * Extracted from index.ts to keep model-catalog concerns in one module.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { ensureServer } from "./server.js";

// ---------------------------------------------------------------------------
// Types (private)
// ---------------------------------------------------------------------------

type OpenCodeAuthMethod = {
  type?: string;
  label?: string;
};

type OpenCodeRawModel = {
  id?: string;
  providerID?: string;
  name?: string;
  family?: string;
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  capabilities?: {
    reasoning?: boolean;
    attachment?: boolean;
    toolcall?: boolean;
  };
};

type OpenCodeRawProvider = {
  id?: string;
  name?: string;
  source?: string;
  env?: Array<string>;
  key?: string;
  models?: Record<string, OpenCodeRawModel>;
};

type OpenCodeProviderCatalogEntry = {
  id: string;
  name: string;
  source: string;
  connected: boolean;
  envKeys: Array<string>;
  authMethods: Array<string>;
  defaultModel?: string;
  modelCount: number;
  loginRequired: boolean;
  envRequired: boolean;
};

// ---------------------------------------------------------------------------
// Types (exported)
// ---------------------------------------------------------------------------

export type OpenCodeModelCatalogEntry = {
  id: string;
  name: string;
  family?: string;
  providerID: string;
  providerName: string;
  providerSource: string;
  connected: boolean;
  selectable: boolean;
  loginRequired: boolean;
  envRequired: boolean;
  authMethods: Array<string>;
  free: boolean;
  status: string;
  contextWindow: number;
  inputWindow?: number;
  outputWindow: number;
  reasoning: boolean;
  attachment: boolean;
  toolcall: boolean;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
};

export type OpenCodeModelCatalog = {
  generatedAt: number;
  providers: Array<OpenCodeProviderCatalogEntry>;
  models: Array<OpenCodeModelCatalogEntry>;
  connectedProviders: Array<OpenCodeProviderCatalogEntry>;
  loginProviders: Array<OpenCodeProviderCatalogEntry>;
  connectedModels: Array<OpenCodeModelCatalogEntry>;
  connectedFreeModels: Array<OpenCodeModelCatalogEntry>;
};

export type OpenCodeModelResolution =
  | { kind: "exact"; model: OpenCodeModelCatalogEntry }
  | { kind: "ambiguous"; matches: Array<OpenCodeModelCatalogEntry> }
  | { kind: "missing"; matches: Array<OpenCodeModelCatalogEntry> };

export type ModelButton = { text: string; callback_data: string };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let modelCatalogCache:
  | {
      expiresAt: number;
      value: OpenCodeModelCatalog;
    }
  | null = null;

export function clearModelCatalogCache(): void {
  modelCatalogCache = null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_PATTERNS: Array<[RegExp, string]> = [
  [/gpt|^o[134]/, "openai"],
  [/gemini/, "google"],
  [/claude/, "anthropic"],
];

const BUCKET_PRIORITY: Record<string, number> = {
  connected: 0, configured: 1, available: 2, all: 3,
};

const OPENCODE_MODEL_CATALOG_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

export function parseOpenCodeModelQuery(
  value: string,
): { providerQuery?: string; modelQuery: string } {
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

function isFreeModel(model: {
  id: string;
  name: string;
  costInput: number;
  costOutput: number;
}): boolean {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  return (
    model.costInput === 0 ||
    model.costOutput === 0 ||
    id.includes("free") ||
    name.includes("free")
  );
}

function sortCatalogModels(
  left: OpenCodeModelCatalogEntry,
  right: OpenCodeModelCatalogEntry,
): number {
  if (left.selectable !== right.selectable) return left.selectable ? -1 : 1;
  if (left.free !== right.free) return left.free ? -1 : 1;
  if (left.providerID !== right.providerID) {
    if (left.providerID === "opencode") return -1;
    if (right.providerID === "opencode") return 1;
    return left.providerID.localeCompare(right.providerID);
  }
  if (left.contextWindow !== right.contextWindow) {
    return right.contextWindow - left.contextWindow;
  }
  return left.name.localeCompare(right.name);
}

function parseCatalogProvider(
  rawProvider: OpenCodeRawProvider,
  connectedProviders: Set<string>,
  defaultModels: Record<string, string>,
  authMap: Record<string, Array<OpenCodeAuthMethod>>,
): OpenCodeProviderCatalogEntry | null {
  const id = rawProvider.id;
  if (!id) return null;

  const authMethods = (authMap[id] ?? [])
    .map((method) => method.label?.trim())
    .filter((label): label is string => Boolean(label));
  const connected = connectedProviders.has(id);
  const envKeys = Array.isArray(rawProvider.env) ? rawProvider.env : [];
  const modelCount = Object.keys(rawProvider.models ?? {}).length;

  return {
    id,
    name: rawProvider.name ?? id,
    source: rawProvider.source ?? "unknown",
    connected,
    envKeys,
    authMethods,
    defaultModel: defaultModels[id],
    modelCount,
    loginRequired: !connected && authMethods.length > 0,
    envRequired: !connected && authMethods.length === 0 && envKeys.length > 0,
  };
}

function parseCatalogModel(
  rawModel: OpenCodeRawModel,
  provider: OpenCodeProviderCatalogEntry,
): OpenCodeModelCatalogEntry | null {
  const id = rawModel.id;
  if (!id) return null;

  const costInput = rawModel.cost?.input ?? 0;
  const costOutput = rawModel.cost?.output ?? 0;
  const costCacheRead = rawModel.cost?.cache?.read ?? 0;
  const costCacheWrite = rawModel.cost?.cache?.write ?? 0;

  const model: OpenCodeModelCatalogEntry = {
    id,
    name: rawModel.name ?? id,
    family: rawModel.family,
    providerID: provider.id,
    providerName: provider.name,
    providerSource: provider.source,
    connected: provider.connected,
    selectable: provider.connected,
    loginRequired: provider.loginRequired,
    envRequired: provider.envRequired,
    authMethods: provider.authMethods,
    free: false,
    status: rawModel.status ?? "unknown",
    contextWindow: rawModel.limit?.context ?? 0,
    inputWindow: rawModel.limit?.input,
    outputWindow: rawModel.limit?.output ?? 0,
    reasoning: rawModel.capabilities?.reasoning ?? false,
    attachment: rawModel.capabilities?.attachment ?? false,
    toolcall: rawModel.capabilities?.toolcall ?? false,
    costInput,
    costOutput,
    costCacheRead,
    costCacheWrite,
  };

  model.free = isFreeModel(model);
  return model;
}

function buildModelCatalog(
  providersData: {
    all?: Array<OpenCodeRawProvider>;
    connected?: Array<string>;
    default?: Record<string, string>;
  },
  authMap: Record<string, Array<OpenCodeAuthMethod>>,
): OpenCodeModelCatalog {
  const connectedProviders = new Set(
    Array.isArray(providersData.connected) ? providersData.connected : [],
  );
  const defaultModels = providersData.default ?? {};
  const providers = (Array.isArray(providersData.all) ? providersData.all : [])
    .map((rawProvider) =>
      parseCatalogProvider(rawProvider, connectedProviders, defaultModels, authMap),
    )
    .filter(
      (provider): provider is OpenCodeProviderCatalogEntry => Boolean(provider),
    )
    .sort((left, right) => {
      if (left.connected !== right.connected) return left.connected ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const models: Array<OpenCodeModelCatalogEntry> = [];

  for (const rawProvider of providersData.all ?? []) {
    const provider = rawProvider.id ? providerById.get(rawProvider.id) : undefined;
    if (!provider) continue;

    for (const rawModel of Object.values(rawProvider.models ?? {})) {
      const model = parseCatalogModel(rawModel, provider);
      if (model) models.push(model);
    }
  }

  models.sort(sortCatalogModels);

  return {
    generatedAt: Date.now(),
    providers,
    models,
    connectedProviders: providers.filter((provider) => provider.connected),
    loginProviders: providers.filter((provider) => provider.loginRequired),
    connectedModels: models.filter((model) => model.selectable),
    connectedFreeModels: models.filter((model) => model.selectable && model.free),
  };
}

// ---------------------------------------------------------------------------
// Exported catalog functions
// ---------------------------------------------------------------------------

export async function getOpenCodeModelCatalog(
  forceRefresh = false,
): Promise<OpenCodeModelCatalog> {
  const now = Date.now();
  if (!forceRefresh && modelCatalogCache && modelCatalogCache.expiresAt > now) {
    return modelCatalogCache.value;
  }

  const oc = await ensureServer();
  const [providersResp, authResp] = await Promise.all([
    oc.provider.list(),
    oc.provider.auth(),
  ]);

  const providersData =
    (providersResp.data as {
      all?: Array<OpenCodeRawProvider>;
      connected?: Array<string>;
      default?: Record<string, string>;
    } | undefined) ?? {};
  const authMap =
    (authResp.data as Record<string, Array<OpenCodeAuthMethod>> | undefined) ?? {};

  const catalog = buildModelCatalog(providersData, authMap);
  modelCatalogCache = {
    expiresAt: now + OPENCODE_MODEL_CATALOG_TTL_MS,
    value: catalog,
  };
  return catalog;
}

export async function getOpenCodeModelInfo(
  modelID: string,
): Promise<OpenCodeModelCatalogEntry | undefined> {
  const catalog = await getOpenCodeModelCatalog();
  const resolution = resolveOpenCodeModelInput(modelID, catalog);
  if (resolution.kind === "missing") return undefined;
  return resolution.kind === "exact" ? resolution.model : resolution.matches[0];
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
      const rightProviderExact = hasProviderExactMatch(right, normalizedProvider);
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
  const exactMatches = matches.filter(
    (model) => {
      const exactModelMatch =
        normalizeModelLookup(model.id) === normalizedModel ||
        normalizeModelLookup(model.name) === normalizedModel;
      if (!exactModelMatch) return false;

      return normalizedProvider
        ? hasProviderExactMatch(model, normalizedProvider)
        : true;
    },
  );
  const selectableExactMatches = exactMatches.filter((model) => model.selectable);

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

function isCallbackSafeModelID(modelID: string): boolean {
  return modelID.length <= 48 && !modelID.includes(":") && !modelID.includes("/");
}

export function getOpenCodeQuickPickModels(
  catalog: OpenCodeModelCatalog,
  currentModelID?: string,
): Array<OpenCodeModelCatalogEntry> {
  const picks: Array<OpenCodeModelCatalogEntry> = [];
  const seen = new Set<string>();

  const tryAdd = (model: OpenCodeModelCatalogEntry | undefined) => {
    if (!model || seen.has(model.id) || !isCallbackSafeModelID(model.id)) return;
    picks.push(model);
    seen.add(model.id);
  };

  if (currentModelID) {
    const currentModel = resolveOpenCodeModelInput(currentModelID, catalog);
    if (currentModel.kind === "exact") {
      tryAdd(currentModel.model);
    } else if (currentModel.kind === "ambiguous") {
      tryAdd(currentModel.matches[0]);
    }
  }

  for (const model of catalog.connectedFreeModels) {
    tryAdd(model);
    if (picks.length >= 4) break;
  }

  if (picks.length < 4) {
    for (const model of catalog.connectedModels) {
      tryAdd(model);
      if (picks.length >= 4) break;
    }
  }

  return picks;
}

function getAvailabilityLabel(model: OpenCodeModelCatalogEntry) {
  if (model.selectable) return model.free ? "ready \u00B7 free" : "ready";
  if (model.loginRequired) return "login required";
  if (model.envRequired) return "credentials required";
  return "not connected";
}

function formatCtxWindow(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export async function getOpenCodeSettingsPresentation(
  activeModel: string,
): Promise<{ modelButtons: Array<ModelButton>; modelDetails: Array<string> }> {
  const catalog = await getOpenCodeModelCatalog();
  const current = await getOpenCodeModelInfo(activeModel);
  const picks = getOpenCodeQuickPickModels(catalog, activeModel);

  const modelButtons: Array<ModelButton> = picks.map((m) => {
    const label = m.id.length <= 20 ? m.id : m.name.length <= 20 ? m.name : m.id;
    const txt = m.free ? `${label} \u2605` : label;
    const sel = current && m.id === current.id && m.providerID === current.providerID;
    return { text: sel ? `\u2713 ${txt}` : txt, callback_data: `settings:model:${m.id}` };
  });
  modelButtons.push({ text: "Reset", callback_data: "settings:model:reset" });

  const details: Array<string> = [];
  if (current) {
    details.push(`Provider: ${current.providerName} \u00B7 ${getAvailabilityLabel(current)}`);
    details.push(`Context: ${formatCtxWindow(current.contextWindow)} \u00B7 reasoning ${current.reasoning ? "yes" : "no"} \u00B7 tools ${current.toolcall ? "yes" : "no"}`);
  }
  const np = catalog.connectedProviders.length;
  const nm = catalog.connectedModels.length;
  details.push(`OpenCode: ${np} provider${np === 1 ? "" : "s"} connected \u00B7 ${nm} model${nm === 1 ? "" : "s"} usable`);
  if (catalog.loginProviders.length > 0) {
    const preview = catalog.loginProviders.slice(0, 4).map((p) => p.name).join(", ");
    details.push(`Login available: ${preview}${catalog.loginProviders.length > 4 ? "\u2026" : ""}`);
  }
  details.push("Hint: use /model free, /model providers, or /model <id>.");
  return { modelButtons, modelDetails: details };
}

export async function renderOpenCodeModelSummary(
  activeModel: string,
  defaultModel: string,
): Promise<{ text: string; quickButtons: Array<ModelButton> }> {
  const { modelButtons, modelDetails } = await getOpenCodeSettingsPresentation(activeModel);
  const catalog = await getOpenCodeModelCatalog();
  const current = await getOpenCodeModelInfo(activeModel);
  const currentLabel = current ? getOpenCodeModelSelectionValue(current, catalog) : activeModel;
  const freePreview = catalog.connectedFreeModels.slice(0, 8);

  const lines = [
    `Model: ${currentLabel}${activeModel === defaultModel ? " (default)" : ""}`,
    ...modelDetails,
  ];
  if (freePreview.length > 0) {
    lines.push("", "Free now");
    for (const m of freePreview) {
      const tags = [m.providerName, m.free ? "free" : `$${m.costInput}/${m.costOutput}`, `${formatCtxWindow(m.contextWindow)} ctx`, getAvailabilityLabel(m)];
      lines.push(`\u2022 ${getOpenCodeModelSelectionValue(m, catalog)} \u2014 ${m.name} (${tags.join(" \u00B7 ")})`);
    }
  }
  return { text: lines.join("\n"), quickButtons: modelButtons };
}

export async function renderOpenCodeModelList(
  mode: "free" | "all" | "providers",
): Promise<string> {
  const catalog = await getOpenCodeModelCatalog();
  if (mode === "providers") {
    const lines = ["OpenCode Providers"];
    for (const p of catalog.providers.slice(0, 24)) {
      const detail = p.connected ? "connected" : p.loginRequired ? `login: ${p.authMethods.join(", ")}` : p.envRequired ? `env: ${p.envKeys.join(", ")}` : p.source;
      lines.push(`\u2022 ${p.name} (${p.id}) \u2014 ${detail} \u00B7 ${p.modelCount} models`);
    }
    if (catalog.providers.length > 24) lines.push(`\u2026and ${catalog.providers.length - 24} more`);
    return lines.join("\n");
  }
  const source = mode === "free" ? catalog.connectedFreeModels : catalog.connectedModels;
  const title = mode === "free" ? "Connected Free Models" : "Connected Models";
  const lines = [title];
  for (const m of source.slice(0, 24)) {
    const tags = [m.providerName, m.free ? "free" : `$${m.costInput}/${m.costOutput}`, `${formatCtxWindow(m.contextWindow)} ctx`, getAvailabilityLabel(m)];
    lines.push(`\u2022 ${getOpenCodeModelSelectionValue(m, catalog)} \u2014 ${m.name} (${tags.join(" \u00B7 ")})`);
  }
  if (source.length > 24) lines.push(`\u2026and ${source.length - 24} more`);
  return lines.join("\n");
}

export function formatOpenCodeSelectionError(
  input: string,
  resolution: Exclude<OpenCodeModelResolution, { kind: "exact" }>,
  catalog: OpenCodeModelCatalog,
) {
  if (resolution.kind === "missing") return `No OpenCode model matched "${input}".`;
  const preview = resolution.matches.slice(0, 6).map((m) => {
    const provider = m.providerName === m.providerID ? m.providerName : `${m.providerName} / ${m.providerID}`;
    return `${getOpenCodeModelSelectionValue(m, catalog)} \u2014 ${provider} (${getAvailabilityLabel(m)})`;
  }).join(", ");
  return `Model query "${input}" is ambiguous. Try one of: ${preview}`;
}

export function formatOpenCodeUnavailableModel(model: OpenCodeModelCatalogEntry) {
  if (model.loginRequired) return `${model.providerName} isn't connected yet. Login methods: ${model.authMethods.join(", ")}.`;
  if (model.envRequired) return `${model.providerName} needs credentials/env setup before ${model.id} can be used.`;
  return `${model.providerName} isn't connected, so ${model.id} can't be selected yet.`;
}
