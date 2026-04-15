/**
 * OpenCode backend — uses the OpenCode SDK as an alternative to Claude Agent SDK.
 *
 * Implements the same QueryBackend interface so it's a drop-in replacement.
 * Manages an OpenCode server process and routes queries through it.
 */

import { setTimeout as sleep } from "node:timers/promises";
import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { TalonConfig } from "../../util/config.js";
import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  getSession,
  incrementTurns,
  recordUsage,
  setSessionId,
  setSessionName,
  resetSession,
} from "../../storage/sessions.js";
import { getChatSettings } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { log, logError, logWarn } from "../../util/log.js";
import { traceMessage } from "../../util/trace.js";

// ── State ───────────────────────────────────────────────────────────────────

let config: TalonConfig;
let client: OpencodeClient | null = null;
let clientPromise: Promise<OpencodeClient> | null = null;
let serverHandle: { url: string; close(): void } | null = null;
let gatewayPortFn: () => number = () => 19876;
let frontendName: "telegram" | "terminal" | "teams" = "telegram";
const modelProviderCache = new Map<string, string>();

const OPENCODE_HOSTNAME = "127.0.0.1";
const OPENCODE_PORT = 4096;
const OPENCODE_BASE_URL = `http://${OPENCODE_HOSTNAME}:${OPENCODE_PORT}`;
const TALON_MCP_SERVER_NAME = "talon-tools";
const OPENCODE_MODEL_CATALOG_TTL_MS = 60_000;
const OPENCODE_SESSION_MESSAGE_LIMIT = 5000;
const OPENCODE_SYSTEM_PROMPT_SUFFIX = `

## OpenCode Delivery Override

- You are running through Talon's OpenCode backend.
- Return your normal user-facing reply as plain assistant text.
- Do not rely on the Telegram send tool for ordinary replies.
- Use tools only when they are genuinely needed for side effects or extra capabilities.
`;

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

type OpenCodeAssistantInfo = {
  role?: string;
  finish?: string;
  time?: {
    created?: number;
    completed?: number;
  };
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: {
      read?: number;
      write?: number;
    };
  };
  providerID?: string;
  modelID?: string;
};

export type OpenCodeProviderCatalogEntry = {
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

export type OpenCodeSessionSnapshot = {
  sessionId: string;
  createdAt?: number;
  updatedAt?: number;
  assistant?: {
    providerID?: string;
    modelID?: string;
    createdAt?: number;
    completedAt?: number;
    costUsd: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
  usage?: {
    assistantMessages: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    totalCostUsd: number;
  };
};

type ParsedAssistantMessage = {
  createdAt: number;
  info?: OpenCodeAssistantInfo;
  parts: Array<Record<string, unknown>>;
};

type OpenCodeUsageSummary = {
  assistantMessages: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

let modelCatalogCache:
  | {
      expiresAt: number;
      value: OpenCodeModelCatalog;
    }
  | null = null;

function createStrictOpencodeClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({
    baseUrl,
    throwOnError: true,
  });
}

function guessProviderID(modelID: string): string {
  const lowerModelID = modelID.toLowerCase();
  if (
    lowerModelID.includes("gpt") ||
    lowerModelID.startsWith("o1") ||
    lowerModelID.startsWith("o3") ||
    lowerModelID.startsWith("o4")
  ) {
    return "openai";
  }
  if (lowerModelID.includes("gemini")) return "google";
  if (lowerModelID.includes("claude")) return "anthropic";
  return "opencode";
}

function getBucketPriority(bucketName: string): number {
  switch (bucketName) {
    case "connected":
      return 0;
    case "configured":
      return 1;
    case "available":
      return 2;
    case "all":
      return 3;
    default:
      return 4;
  }
}

function extractPartsSummary(
  parts: Array<Record<string, unknown>>,
): { text: string; toolCalls: number } {
  const textParts: string[] = [];
  let toolCalls = 0;

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      textParts.push(part.text);
    } else if (part.type === "tool") {
      toolCalls++;
    }
  }

  return {
    text: textParts.join("\n\n").trim(),
    toolCalls,
  };
}

function normalizeModelLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[`"']/g, "").replace(/\s+/g, "-");
}

function parseOpenCodeModelQuery(
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

function parseStoredOpenCodeModelSelection(
  value: string,
): { providerID?: string; modelID: string } {
  const { providerQuery, modelQuery } = parseOpenCodeModelQuery(value);
  return {
    providerID: providerQuery ? normalizeModelLookup(providerQuery) : undefined,
    modelID: modelQuery,
  };
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

export function clearOpenCodeModelCatalogCache(): void {
  modelCatalogCache = null;
}

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
    const normalizedId = normalizeModelLookup(model.id);
    const normalizedName = normalizeModelLookup(model.name);
    const modelMatches =
      normalizedId === normalizedModel ||
      normalizedName === normalizedModel ||
      normalizedId.startsWith(normalizedModel) ||
      normalizedName.startsWith(normalizedModel) ||
      normalizedId.includes(normalizedModel) ||
      normalizedName.includes(normalizedModel);
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

function extractAssistantUsage(
  info: OpenCodeAssistantInfo | undefined,
): {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  providerID?: string;
  modelID?: string;
} {
  return {
    inputTokens: info?.tokens?.input ?? 0,
    outputTokens: info?.tokens?.output ?? 0,
    cacheRead: info?.tokens?.cache?.read ?? 0,
    cacheWrite: info?.tokens?.cache?.write ?? 0,
    costUsd: info?.cost ?? 0,
    providerID: info?.providerID,
    modelID: info?.modelID,
  };
}

function hasAssistantUsage(info: OpenCodeAssistantInfo | undefined): boolean {
  return Boolean(
    info?.tokens?.input ||
      info?.tokens?.output ||
      info?.tokens?.reasoning ||
      info?.tokens?.cache?.read ||
      info?.tokens?.cache?.write ||
      info?.cost,
  );
}

function createEmptyUsageSummary(): OpenCodeUsageSummary {
  return {
    assistantMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  };
}

function parseAssistantMessage(
  message: unknown,
): ParsedAssistantMessage | null {
  if (!message || typeof message !== "object") return null;

  const data = message as {
    info?: OpenCodeAssistantInfo;
    parts?: Array<Record<string, unknown>>;
  };

  if (data.info?.role !== "assistant") return null;

  return {
    createdAt: data.info?.time?.created ?? 0,
    info: data.info,
    parts: Array.isArray(data.parts) ? data.parts : [],
  };
}

function isMeaningfulAssistantMessage(message: ParsedAssistantMessage): boolean {
  return Boolean(
    message.parts.length > 0 ||
      message.info?.time?.completed ||
      hasAssistantUsage(message.info),
  );
}

export function summarizeOpenCodeAssistantMessages(
  messages: Array<unknown>,
  minCreatedAt = 0,
): {
  latestAssistant?: ParsedAssistantMessage;
  usage: OpenCodeUsageSummary;
} {
  const usage = createEmptyUsageSummary();
  const assistants = messages
    .map((message) => parseAssistantMessage(message))
    .filter((message): message is ParsedAssistantMessage => Boolean(message))
    .filter(
      (message) =>
        message.createdAt >= minCreatedAt && isMeaningfulAssistantMessage(message),
    );

  for (const assistant of assistants) {
    const assistantUsage = extractAssistantUsage(assistant.info);
    usage.assistantMessages += 1;
    usage.inputTokens += assistantUsage.inputTokens;
    usage.outputTokens += assistantUsage.outputTokens;
    usage.reasoningTokens += assistant.info?.tokens?.reasoning ?? 0;
    usage.cacheRead += assistantUsage.cacheRead;
    usage.cacheWrite += assistantUsage.cacheWrite;
    usage.costUsd += assistantUsage.costUsd;
  }

  const latestAssistant = assistants.sort(
    (left, right) => right.createdAt - left.createdAt,
  )[0];

  return { latestAssistant, usage };
}

function getChatMcpServerName(chatId: string): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]+/g, "_") || "chat";
  return `${TALON_MCP_SERVER_NAME}-${safeChatId}`;
}

function isTalonToolID(toolID: string): boolean {
  return (
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}_`) ||
    toolID.startsWith(`${TALON_MCP_SERVER_NAME}-`)
  );
}

function summarizeQuestionHeaders(
  questions: Array<Record<string, unknown>>,
): string {
  return questions
    .map((question) => {
      if (typeof question.header === "string" && question.header.trim()) {
        return question.header.trim();
      }

      if (typeof question.question === "string" && question.question.trim()) {
        return question.question.trim();
      }

      return null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" | ");
}

async function rejectPendingQuestions(
  oc: OpencodeClient,
  sessionId: string,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<void> {
  const questionsResp = await oc.question.list();
  const pendingQuestions = Array.isArray(questionsResp.data)
    ? questionsResp.data
    : [];

  for (const request of pendingQuestions) {
    if (!request || typeof request !== "object") continue;

    const data = request as {
      id?: string;
      sessionID?: string;
      questions?: Array<Record<string, unknown>>;
    };

    const requestId = data.id;
    if (!requestId || data.sessionID !== sessionId) continue;
    if (seenQuestionIds.has(requestId)) continue;

    seenQuestionIds.add(requestId);
    const questions = Array.isArray(data.questions) ? data.questions : [];
    const summary = summarizeQuestionHeaders(questions);

    logWarn(
      "agent",
      `[${chatId}] Rejecting OpenCode question ${requestId}${summary ? `: ${summary}` : ""}`,
    );

    try {
      await oc.question.reject({ requestID: requestId });
    } catch (err) {
      logWarn(
        "agent",
        `[${chatId}] Failed to reject OpenCode question ${requestId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

async function waitForPromptWithQuestionGuard(
  oc: OpencodeClient,
  parameters: Parameters<OpencodeClient["session"]["prompt"]>[0],
  chatId: string,
  seenQuestionIds: Set<string>,
) {
  let finished = false;

  const watchdog = (async () => {
    while (!finished) {
      try {
        await rejectPendingQuestions(
          oc,
          parameters.sessionID,
          chatId,
          seenQuestionIds,
        );
      } catch (err) {
        logWarn(
          "agent",
          `[${chatId}] Failed while polling OpenCode questions: ${err instanceof Error ? err.message : err}`,
        );
      }

      if (!finished) {
        await sleep(350);
      }
    }
  })();

  try {
    return await oc.session.prompt(parameters);
  } finally {
    finished = true;
    await watchdog;
    await rejectPendingQuestions(
      oc,
      parameters.sessionID,
      chatId,
      seenQuestionIds,
    );
  }
}

async function waitForAssistantReply(
  oc: OpencodeClient,
  sessionId: string,
  minCreatedAt: number,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<{
  text: string;
  toolCalls: number;
  info?: OpenCodeAssistantInfo;
}> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    await rejectPendingQuestions(oc, sessionId, chatId, seenQuestionIds);

    const messagesResp = await oc.session.messages({
      sessionID: sessionId,
      limit: 20,
    });
    const messages = Array.isArray(messagesResp.data) ? messagesResp.data : [];

    const assistantMessages = messages
      .map((message) => parseAssistantMessage(message))
      .filter(
        (
          message,
        ): message is {
          createdAt: number;
          info?: OpenCodeAssistantInfo;
          parts: Array<Record<string, unknown>>;
        } => Boolean(message),
      )
      .sort((left, right) => right.createdAt - left.createdAt);

    for (const message of assistantMessages) {
      if (message.createdAt < minCreatedAt) continue;

      const summary = extractPartsSummary(message.parts);
      if (summary.text || summary.toolCalls > 0) {
        return {
          ...summary,
          info: message.info,
        };
      }
    }

    await sleep(500);
  }

  return { text: "", toolCalls: 0 };
}

async function listSessionMessages(
  oc: OpencodeClient,
  sessionId: string,
  limit = OPENCODE_SESSION_MESSAGE_LIMIT,
): Promise<Array<unknown>> {
  const resp = await oc.session.messages({
    sessionID: sessionId,
    limit,
  });
  const page = Array.isArray(resp.data) ? resp.data : [];
  const messages: Array<unknown> = [];
  const seenMessageIds = new Set<string>();

  for (const message of page) {
    const messageId =
      message &&
      typeof message === "object" &&
      typeof (message as { info?: { id?: string } }).info?.id === "string"
        ? (message as { info: { id: string } }).info.id
        : undefined;

    if (messageId && seenMessageIds.has(messageId)) continue;
    if (messageId) seenMessageIds.add(messageId);
    messages.push(message);
  }

  return messages;
}

async function getOpenCodeTurnSummary(
  oc: OpencodeClient,
  sessionId: string,
  minCreatedAt: number,
): Promise<{
  latestAssistant?: ParsedAssistantMessage;
  usage: OpenCodeUsageSummary;
}> {
  const messages = await listSessionMessages(oc, sessionId);
  return summarizeOpenCodeAssistantMessages(messages, minCreatedAt);
}

export async function getOpenCodeSessionSnapshot(
  sessionId: string,
): Promise<OpenCodeSessionSnapshot | undefined> {
  if (!sessionId) return undefined;

  const oc = await ensureServer();
  const [sessionResp, messages] = await Promise.all([
    oc.session.get({ sessionID: sessionId }),
    listSessionMessages(oc, sessionId),
  ]);

  const sessionInfo =
    (sessionResp.data as {
      time?: {
        created?: number;
        updated?: number;
      };
    } | undefined) ?? {};
  const summary = summarizeOpenCodeAssistantMessages(messages);
  const latestAssistant = summary.latestAssistant;
  const usage = extractAssistantUsage(latestAssistant?.info);

  return {
    sessionId,
    createdAt: sessionInfo.time?.created,
    updatedAt: sessionInfo.time?.updated,
    assistant: latestAssistant
      ? {
          providerID: usage.providerID,
          modelID: usage.modelID,
          createdAt: latestAssistant.info?.time?.created,
          completedAt: latestAssistant.info?.time?.completed,
          costUsd: usage.costUsd,
          totalTokens: latestAssistant.info?.tokens?.total ?? 0,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: latestAssistant.info?.tokens?.reasoning ?? 0,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
        }
      : undefined,
    usage: {
      assistantMessages: summary.usage.assistantMessages,
      totalInputTokens: summary.usage.inputTokens,
      totalOutputTokens: summary.usage.outputTokens,
      totalReasoningTokens: summary.usage.reasoningTokens,
      totalCacheRead: summary.usage.cacheRead,
      totalCacheWrite: summary.usage.cacheWrite,
      totalCostUsd: summary.usage.costUsd,
    },
  };
}

async function resolveProviderID(
  oc: OpencodeClient,
  modelID: string,
): Promise<string> {
  const cachedProviderID = modelProviderCache.get(modelID);
  if (cachedProviderID) return cachedProviderID;

  const providerResp = await oc.provider.list();
  const providerBuckets =
    (providerResp.data as Record<string, unknown> | undefined) ?? {};
  const guessedProviderID = guessProviderID(modelID);
  const matches: Array<{ providerID: string; bucketName: string }> = [];

  for (const [bucketName, bucket] of Object.entries(providerBuckets)) {
    if (!Array.isArray(bucket)) continue;

    for (const provider of bucket) {
      if (!provider || typeof provider !== "object") continue;

      const providerData = provider as {
        id?: string;
        models?: Record<string, { providerID?: string }>;
      };

      const modelEntry = providerData.models?.[modelID];
      if (!modelEntry) continue;

      const providerID = modelEntry.providerID ?? providerData.id;
      if (!providerID) continue;

      matches.push({ providerID, bucketName });
    }
  }

  if (matches.length > 0) {
    matches.sort((left, right) => {
      const leftGuessPenalty = left.providerID === guessedProviderID ? 0 : 1;
      const rightGuessPenalty = right.providerID === guessedProviderID ? 0 : 1;
      if (leftGuessPenalty !== rightGuessPenalty) {
        return leftGuessPenalty - rightGuessPenalty;
      }

      const leftOpencodePenalty = left.providerID === "opencode" ? 0 : 1;
      const rightOpencodePenalty = right.providerID === "opencode" ? 0 : 1;
      if (leftOpencodePenalty !== rightOpencodePenalty) {
        return leftOpencodePenalty - rightOpencodePenalty;
      }

      return (
        getBucketPriority(left.bucketName) - getBucketPriority(right.bucketName)
      );
    });

    const resolvedProviderID = matches[0].providerID;
    modelProviderCache.set(modelID, resolvedProviderID);
    return resolvedProviderID;
  }

  const fallbackProviderID = guessProviderID(modelID);
  modelProviderCache.set(modelID, fallbackProviderID);
  logWarn(
    "agent",
    `Could not resolve provider for model ${modelID}; falling back to ${fallbackProviderID}`,
  );
  return fallbackProviderID;
}

export function initOpenCodeAgent(
  cfg: TalonConfig,
  getGatewayPort?: () => number,
  frontend?: "telegram" | "terminal" | "teams",
): void {
  config = cfg;
  if (getGatewayPort) gatewayPortFn = getGatewayPort;
  if (frontend) frontendName = frontend;
}

// ── Server lifecycle ────────────────────────────────────────────────────────

async function ensureServer(): Promise<OpencodeClient> {
  if (client) return client;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const existingClient = await reuseExistingServer();
    if (existingClient) {
      client = existingClient;
      return existingClient;
    }

    log("agent", "Starting OpenCode server...");

    try {
      const server = await createOpencodeServer({
        hostname: OPENCODE_HOSTNAME,
        port: OPENCODE_PORT,
        timeout: 10_000,
      });
      client = createStrictOpencodeClient(server.url);
      serverHandle = server;
      log("agent", `OpenCode server running at ${server.url}`);
    } catch (err) {
      const reusedClient = await reuseExistingServer();
      if (!reusedClient) throw err;

      client = reusedClient;
      logWarn(
        "agent",
        `OpenCode server already became available at ${OPENCODE_BASE_URL}; reusing it`,
      );
    }

    return client;
  })();

  try {
    return await clientPromise;
  } finally {
    clientPromise = null;
  }
}

async function reuseExistingServer(): Promise<OpencodeClient | null> {
  try {
    const response = await fetch(`${OPENCODE_BASE_URL}/global/health`);
    if (!response.ok) return null;

    const existingClient = createStrictOpencodeClient(OPENCODE_BASE_URL);
    log("agent", `Reusing OpenCode server at ${OPENCODE_BASE_URL}`);
    return existingClient;
  } catch {
    return null;
  }
}

async function registerMcpServer(oc: OpencodeClient): Promise<void> {
  await ensureChatMcpServer(oc, "default");
}

async function ensureChatMcpServer(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  const serverName = getChatMcpServerName(chatId);

  try {
    const statusResp = await oc.mcp.status();
    const mcpServers =
      (statusResp.data as Record<string, { status?: string }> | undefined) ?? {};
    const talonTools = mcpServers[serverName];

    if (talonTools?.status === "connected") {
      return serverName;
    }

    const toolsPath = new URL("../../core/tools/mcp-server.ts", import.meta.url)
      .pathname;
    await oc.mcp.add({
      name: serverName,
      config: {
        type: "local" as const,
        command: ["node", "--import", "tsx", toolsPath],
        environment: {
          TALON_BRIDGE_URL: `http://127.0.0.1:${gatewayPortFn()}`,
          TALON_CHAT_ID: chatId,
          TALON_FRONTEND: frontendName,
        },
      },
    });
    log("agent", `Registered ${serverName} MCP server with OpenCode`);
  } catch (err) {
    logWarn(
      "agent",
      `MCP registration failed for ${serverName} (tools may not be available): ${err instanceof Error ? err.message : err}`,
    );
  }

  return serverName;
}

async function buildToolOverrides(
  oc: OpencodeClient,
  chatServerName: string,
): Promise<Record<string, boolean> | undefined> {
  try {
    const toolIdsResp = await oc.tool.ids();
    const toolIds = Array.isArray(toolIdsResp.data) ? toolIdsResp.data : [];
    const overrides: Record<string, boolean> = {};
    const chatToolPrefix = `${chatServerName}_`;
    let matchedChatTool = false;

    for (const toolId of toolIds) {
      if (typeof toolId !== "string" || !isTalonToolID(toolId)) continue;

      const enabled = toolId.startsWith(chatToolPrefix);
      overrides[toolId] = enabled;
      matchedChatTool ||= enabled;
    }

    return matchedChatTool ? overrides : undefined;
  } catch (err) {
    logWarn(
      "agent",
      `Failed to build OpenCode tool overrides for ${chatServerName}: ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

async function disconnectChatMcpServer(
  oc: OpencodeClient,
  serverName: string,
): Promise<void> {
  try {
    await oc.mcp.disconnect({ name: serverName });
  } catch (err) {
    logWarn(
      "agent",
      `Failed to disconnect ${serverName}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export function stopOpenCodeServer(): void {
  clientPromise = null;
  modelProviderCache.clear();
  clearOpenCodeModelCatalogCache();
  if (serverHandle) {
    serverHandle.close();
    serverHandle = null;
    client = null;
    log("agent", "OpenCode server stopped");
  }
}

// ── Session management ──────────────────────────────────────────────────────

async function ensureSession(
  oc: OpencodeClient,
  chatId: string,
): Promise<string> {
  const session = getSession(chatId);

  if (session.sessionId) {
    // Verify session still exists
    try {
      await oc.session.get({ sessionID: session.sessionId });
      return session.sessionId;
    } catch {
      logWarn(
        "agent",
        `[${chatId}] Session ${session.sessionId} expired, creating new`,
      );
      resetSession(chatId);
    }
  }

  // Create new session
  const resp = await oc.session.create({ title: `Chat ${chatId}` });

  // Extract session ID from response
  const data = resp.data as Record<string, unknown> | undefined;
  const newId = (data?.id as string) ?? String(Date.now());
  setSessionId(chatId, newId);
  log("agent", `[${chatId}] Created OpenCode session: ${newId}`);
  return newId;
}

// ── Main handler ────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  if (!config) throw new Error("OpenCode agent not initialized");

  const { chatId, text, senderName, isGroup, onTextBlock } = params;
  const t0 = Date.now();
  const previousTurns = getSession(chatId).turns;

  const chatSettings = getChatSettings(chatId);
  const activeModel = chatSettings.model ?? config.model;
  const { providerID: selectedProviderID, modelID } =
    parseStoredOpenCodeModelSelection(activeModel);

  const oc = await ensureServer();
  const providerID =
    selectedProviderID ?? (await resolveProviderID(oc, modelID));
  const sessionId = await ensureSession(oc, chatId);
  const chatMcpServerName = await ensureChatMcpServer(oc, chatId);
  const toolOverrides = await buildToolOverrides(oc, chatMcpServerName);
  const seenQuestionIds = new Set<string>();

  // Build prompt with group context
  const msgIdHint = params.messageId ? ` [msg_id:${params.messageId}]` : "";
  const prompt = isGroup
    ? `[${senderName}]${msgIdHint}: ${text}`
    : `${text}${msgIdHint}`;

  log("agent", `[${chatId}] <- (${text.length} chars)`);
  traceMessage(chatId, "in", text, { senderName, isGroup });

  try {
    const promptStartedAt = Date.now();
    const resp = await waitForPromptWithQuestionGuard(
      oc,
      {
      sessionID: sessionId,
      parts: [{ type: "text" as const, text: prompt }],
      model: { providerID, modelID },
      system: config.systemPrompt + OPENCODE_SYSTEM_PROMPT_SUFFIX,
      ...(toolOverrides ? { tools: toolOverrides } : {}),
      },
      chatId,
      seenQuestionIds,
    );

    const data = resp.data as Record<string, unknown> | undefined;
    const parts = Array.isArray(data?.parts)
      ? (data.parts as Array<Record<string, unknown>>)
      : [];
    let assistantInfo =
      data?.info && typeof data.info === "object"
        ? (data.info as OpenCodeAssistantInfo)
        : undefined;

    let { text: responseText, toolCalls } = extractPartsSummary(parts);

    if (!responseText) {
      const fallbackReply = await waitForAssistantReply(
        oc,
        sessionId,
        promptStartedAt,
        chatId,
        seenQuestionIds,
      );
      responseText = fallbackReply.text;
      toolCalls = Math.max(toolCalls, fallbackReply.toolCalls);
      assistantInfo = fallbackReply.info ?? assistantInfo;
    }

    const turnSummary = await getOpenCodeTurnSummary(oc, sessionId, promptStartedAt);
    const fallbackUsage = extractAssistantUsage(assistantInfo);
    const usage =
      turnSummary.usage.assistantMessages > 0
        ? {
            inputTokens: turnSummary.usage.inputTokens,
            outputTokens: turnSummary.usage.outputTokens,
            cacheRead: turnSummary.usage.cacheRead,
            cacheWrite: turnSummary.usage.cacheWrite,
            costUsd: turnSummary.usage.costUsd,
            providerID:
              turnSummary.latestAssistant?.info?.providerID ?? fallbackUsage.providerID,
            modelID:
              turnSummary.latestAssistant?.info?.modelID ?? fallbackUsage.modelID,
          }
        : fallbackUsage;

    if (!responseText) {
      logWarn(
        "agent",
        `[${chatId}] OpenCode returned no assistant text for ${providerID}/${modelID}`,
      );
      responseText =
        "Sorry — I got an empty response from OpenCode. Please try again.";
    }

    if (responseText && onTextBlock) {
      await onTextBlock(responseText);
    }

    const durationMs = Date.now() - t0;

    // Persist session state
    incrementTurns(chatId);
    recordUsage(chatId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      durationMs,
      model: usage.modelID ?? activeModel,
      costUsd: usage.costUsd,
    });

    if (previousTurns === 0 && text) {
      const cleanText = text
        .replace(/^\[.*?\]\s*/g, "")
        .replace(/\[msg_id:\d+\]\s*/g, "")
        .trim();
      if (cleanText) {
        setSessionName(
          chatId,
          cleanText.length > 30 ? cleanText.slice(0, 30) + "..." : cleanText,
        );
      }
    }

    log(
      "agent",
      `[${chatId}] -> (${durationMs}ms${toolCalls > 0 ? ` tools=${toolCalls}` : ""})`,
    );
    traceMessage(chatId, "out", responseText, { durationMs, toolCalls });

    return {
      text: responseText.trim(),
      durationMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    };
  } catch (err) {
    const classified = classify(err);
    // Session expired — reset and retry once
    if (classified.reason === "session_expired" && !_retried) {
      logWarn("agent", `[${chatId}] OpenCode session expired, retrying`);
      resetSession(chatId);
      return handleMessage(params, true);
    }
    logError("agent", `[${chatId}] OpenCode error: ${classified.message}`);
    throw classified;
  } finally {
    await disconnectChatMcpServer(oc, chatMcpServerName);
  }
}
