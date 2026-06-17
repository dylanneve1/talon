/**
 * Kilo model catalog — TTL cache, raw→catalog parsing, and the fetch entry
 * point that hits Kilo's `/provider/list` + `/provider/auth` endpoints.
 */

import { ensureServer } from "../server.js";
import { normalizeReasoningLevels } from "../../../core/models/reasoning-levels.js";
import type {
  OpenCodeAuthMethod,
  OpenCodeModelCatalog,
  OpenCodeModelCatalogEntry,
  OpenCodeProviderCatalogEntry,
  OpenCodeRawModel,
  OpenCodeRawProvider,
} from "./types.js";

// ── Cache ────────────────────────────────────────────────────────────────────

let modelCatalogCache: {
  expiresAt: number;
  value: OpenCodeModelCatalog;
} | null = null;

export function clearModelCatalogCache(): void {
  modelCatalogCache = null;
}

const OPENCODE_MODEL_CATALOG_TTL_MS = 60_000;

// ── Parsing helpers ──────────────────────────────────────────────────────────

function isFreeModel(model: {
  id: string;
  name: string;
  costInput: number;
  costOutput: number;
}): boolean {
  const id = model.id.toLowerCase();
  const name = model.name.toLowerCase();
  return (
    (model.costInput === 0 && model.costOutput === 0) ||
    id.includes("free") ||
    name.includes("free")
  );
}

export function sortCatalogModels(
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
  const supportedReasoningLevels = extractReasoningLevels(rawModel);
  const defaultReasoningLevel = normalizeReasoningLevels(
    [
      rawModel.defaultReasoningLevel,
      rawModel.default_reasoning_level,
      readString(rawModel.options?.defaultReasoningLevel),
      readString(rawModel.options?.default_reasoning_level),
    ].filter((level): level is string => typeof level === "string"),
  )[0];

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
    reasoning:
      rawModel.capabilities?.reasoning ?? supportedReasoningLevels.length > 0,
    ...(supportedReasoningLevels.length ? { supportedReasoningLevels } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
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

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function extractReasoningLevels(rawModel: OpenCodeRawModel) {
  return normalizeReasoningLevels([
    ...(rawModel.supportedReasoningLevels ?? []),
    ...(rawModel.supported_reasoning_levels ?? []),
    ...(rawModel.capabilities?.supportedReasoningLevels ?? []),
    ...(rawModel.capabilities?.supported_reasoning_levels ?? []),
    ...readStringArray(rawModel.options?.supportedReasoningLevels),
    ...readStringArray(rawModel.options?.supported_reasoning_levels),
  ]);
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
      parseCatalogProvider(
        rawProvider,
        connectedProviders,
        defaultModels,
        authMap,
      ),
    )
    .filter((provider): provider is OpenCodeProviderCatalogEntry =>
      Boolean(provider),
    )
    .sort((left, right) => {
      if (left.connected !== right.connected) return left.connected ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  const providerById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const models: Array<OpenCodeModelCatalogEntry> = [];

  for (const rawProvider of providersData.all ?? []) {
    const provider = rawProvider.id
      ? providerById.get(rawProvider.id)
      : undefined;
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
    connectedFreeModels: models.filter(
      (model) => model.selectable && model.free,
    ),
  };
}

// ── Fetch entry point ────────────────────────────────────────────────────────

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
    (providersResp.data as
      | {
          all?: Array<OpenCodeRawProvider>;
          connected?: Array<string>;
          default?: Record<string, string>;
        }
      | undefined) ?? {};
  const authMap =
    (authResp.data as Record<string, Array<OpenCodeAuthMethod>> | undefined) ??
    {};

  const catalog = buildModelCatalog(providersData, authMap);
  modelCatalogCache = {
    expiresAt: now + OPENCODE_MODEL_CATALOG_TTL_MS,
    value: catalog,
  };
  return catalog;
}
