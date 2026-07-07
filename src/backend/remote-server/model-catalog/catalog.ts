/**
 * Remote model catalog — raw→catalog parsing, sorting, and the TTL-cached
 * fetch store that hits the backend's `/provider/list` + `/provider/auth`
 * endpoints.
 *
 * Pure parsing/sorting lives at module level; the fetch + cache is a factory
 * (`createRemoteModelCatalogStore`) so each backend binds its own SDK client
 * and keeps its own cache.
 */

import { normalizeReasoningLevels } from "../../../core/models/reasoning-levels.js";
import type {
  RemoteAuthMethod,
  RemoteModelCatalog,
  RemoteModelCatalogEntry,
  RemoteProviderCatalogEntry,
  RemoteProviderClient,
  RemoteRawModel,
  RemoteRawProvider,
  RemoteRawProvidersData,
} from "./types.js";

const DEFAULT_CATALOG_TTL_MS = 60_000;

// ── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * A model is free only when BOTH directions cost 0 (a $0-input/$5-output
 * model is not free) or it is explicitly badged "free" in its id/name.
 */
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
  left: RemoteModelCatalogEntry,
  right: RemoteModelCatalogEntry,
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
  rawProvider: RemoteRawProvider,
  connectedProviders: Set<string>,
  defaultModels: Record<string, string>,
  authMap: Record<string, Array<RemoteAuthMethod>>,
): RemoteProviderCatalogEntry | null {
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
  rawModel: RemoteRawModel,
  provider: RemoteProviderCatalogEntry,
): RemoteModelCatalogEntry | null {
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

  const model: RemoteModelCatalogEntry = {
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

function extractReasoningLevels(rawModel: RemoteRawModel) {
  return normalizeReasoningLevels([
    ...(rawModel.supportedReasoningLevels ?? []),
    ...(rawModel.supported_reasoning_levels ?? []),
    ...(rawModel.capabilities?.supportedReasoningLevels ?? []),
    ...(rawModel.capabilities?.supported_reasoning_levels ?? []),
    ...readStringArray(rawModel.options?.supportedReasoningLevels),
    ...readStringArray(rawModel.options?.supported_reasoning_levels),
  ]);
}

export function buildModelCatalog(
  providersData: RemoteRawProvidersData,
  authMap: Record<string, Array<RemoteAuthMethod>>,
): RemoteModelCatalog {
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
    .filter((provider): provider is RemoteProviderCatalogEntry =>
      Boolean(provider),
    )
    .sort((left, right) => {
      if (left.connected !== right.connected) return left.connected ? -1 : 1;
      return left.name.localeCompare(right.name);
    });

  const providerById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const models: Array<RemoteModelCatalogEntry> = [];

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

// ── Fetch store factory ──────────────────────────────────────────────────────

export interface RemoteModelCatalogStore {
  getCatalog(forceRefresh?: boolean): Promise<RemoteModelCatalog>;
  clearCache(): void;
}

/**
 * Build a TTL-cached catalog store bound to one backend's SDK client.
 * `getClient` is typically the backend's `ensureServer` — invoked lazily so
 * the server only boots when the catalog is actually needed.
 */
export function createRemoteModelCatalogStore(options: {
  getClient: () => Promise<RemoteProviderClient>;
  ttlMs?: number;
}): RemoteModelCatalogStore {
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS;
  let cache: { expiresAt: number; value: RemoteModelCatalog } | null = null;

  return {
    async getCatalog(forceRefresh = false): Promise<RemoteModelCatalog> {
      const now = Date.now();
      if (!forceRefresh && cache && cache.expiresAt > now) {
        return cache.value;
      }

      const client = await options.getClient();
      const [providersResp, authResp] = await Promise.all([
        client.provider.list(),
        client.provider.auth(),
      ]);

      const providersData =
        (providersResp.data as RemoteRawProvidersData | undefined) ?? {};
      const authMap =
        (authResp.data as
          Record<string, Array<RemoteAuthMethod>> | undefined) ?? {};

      const catalog = buildModelCatalog(providersData, authMap);
      cache = { expiresAt: now + ttlMs, value: catalog };
      return catalog;
    },
    clearCache(): void {
      cache = null;
    },
  };
}
