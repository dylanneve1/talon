/**
 * Test helper — build a `Backend` from a flat fixture description.
 *
 * Tests typically want to assert on something simple ("the dispatcher
 * called query with these params", "the picker used the backend's
 * resolveModel"). Hand-rolling the full split-slot `Backend` shape
 * per test pollutes intent. `stubBackend` accepts any subset of
 * flat method references and composes them onto the corresponding
 * capability slots:
 *
 *   - `query` → `chat.runChatTurn` (via `handlerToEvents`)
 *   - `runOneShotAgent` / `evictOrphanSubprocesses` → `background`
 *   - `resolveModel` / `getDefaultModel` / `getModelInfo` /
 *     `getSettingsPresentation` / `getProviders` /
 *     `getProviderModels` / `formatModelError` / `listModels` →
 *     `models` (mapped onto the slot's UnifiedModelInfo-shaped
 *     methods: `resolveModelInfo`, `getDefaultModelId`,
 *     `getRawModelInfo`, `listModelsRaw`, etc.)
 *   - `resetChat` / `warmSession` → `sessions`
 *   - `refreshMcpServers` → `tools.refreshTools`
 *   - `updateSystemPrompt` → `control.updateSystemPrompt`
 *   - `getSessionSnapshot` → `usage`
 *
 * Production code never uses this — `composeBackend` from
 * `core/agent-runtime/capabilities.ts` is the canonical builder
 * there. The helper exists so common test fixtures don't have to
 * rewrite every capability slot from scratch per case.
 */

import { vi } from "vitest";
import type {
  Backend,
  BackgroundRunner,
  ChatBackend,
  ModelCatalog,
  SessionBackend,
  SystemControl,
  ToolRuntime,
  UsageTelemetry,
} from "../../core/agent-runtime/capabilities.js";
import { composeBackend } from "../../core/agent-runtime/capabilities.js";
import { handlerToEvents } from "../../backend/shared/handler-to-events.js";
import type { BackendId } from "../../core/agent-runtime/model-ref.js";
import { makeBareModelRef } from "../../core/agent-runtime/model-ref.js";
import type {
  CacheMetricsSupport,
  OneShotAgentParams,
  UnifiedModelInfo,
  UnifiedModelResolution,
  UnifiedProviderInfo,
  ModelPickerOptions,
  ModelPickerResult,
} from "../../core/types.js";
import type {
  QueryParams,
  QueryResult,
} from "../../backend/shared/handler-types.js";

export interface StubBackendInput {
  id?: BackendId;
  label?: string;
  cacheMetrics?: CacheMetricsSupport;

  // Chat
  query?: (params: QueryParams) => Promise<QueryResult>;
  chat?: ChatBackend;

  // Background
  runOneShotAgent?: (params: OneShotAgentParams) => Promise<void>;
  evictOrphanSubprocesses?: (label: string) => Promise<{
    found: number;
    termed: number;
    killed: number;
  }>;
  background?: BackgroundRunner;

  // Models — flat (legacy-named) signatures get adapted onto the
  // ModelCatalog slot. Tests can also pass a fully-built `models`
  // slot directly to opt out of the adapter wiring.
  resolveModel?: (q: string) => Promise<UnifiedModelResolution>;
  getDefaultModel?: () =>
    | Promise<string | null | undefined>
    | string
    | null
    | undefined;
  getModelInfo?: (id: string) => Promise<UnifiedModelInfo | undefined>;
  getSettingsPresentation?: (
    activeModel: string,
    options?: ModelPickerOptions,
  ) => Promise<ModelPickerResult>;
  getProviders?: () => Promise<UnifiedProviderInfo[]>;
  getProviderModels?: (
    providerId: string,
    page?: number,
    pageSize?: number,
  ) => Promise<{ models: UnifiedModelInfo[]; total: number }>;
  formatModelError?: (
    query: string,
    resolution: UnifiedModelResolution,
  ) => string;
  listModels?: (filter?: "free" | "all") => Promise<{
    models: UnifiedModelInfo[];
    total: number;
  }>;
  models?: ModelCatalog;

  // Sessions
  resetChat?: (chatId: string) => void | Promise<void>;
  warmSession?: (chatId: string) => Promise<void>;
  sessions?: SessionBackend;

  // Tools
  refreshMcpServers?: (chatId: string) => Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  } | null>;
  tools?: ToolRuntime;

  // Usage
  getSessionSnapshot?: (sessionId: string) => Promise<
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheRead?: number;
        cacheWrite?: number;
        contextModelId?: string;
      }
    | undefined
  >;
  usage?: UsageTelemetry;

  // Control
  updateSystemPrompt?: (prompt: string) => void;
  control?: SystemControl;
}

const defaultQuery = vi.fn(
  async (): Promise<QueryResult> => ({
    text: "stub response",
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }),
);

function buildModels(input: StubBackendInput): ModelCatalog | undefined {
  if (input.models) return input.models;
  const hasAny =
    input.resolveModel ||
    input.getDefaultModel ||
    input.getModelInfo ||
    input.getSettingsPresentation ||
    input.getProviders ||
    input.getProviderModels ||
    input.formatModelError ||
    input.listModels;
  if (!hasAny) return undefined;
  // The ModelCatalog interface is required-by-default. Fill any
  // slot the test didn't provide with a no-op default so the
  // capability flag still flips on when at least one method is
  // populated.
  return {
    resolveModelInfo:
      input.resolveModel ?? (async () => ({ kind: "missing" }) as const),
    getDefaultModelId: input.getDefaultModel ?? (() => undefined),
    getRawModelInfo: input.getModelInfo ?? (async () => undefined),
    getSettingsPresentation:
      input.getSettingsPresentation ??
      (async () => ({
        modelButtons: [],
        modelDetails: [],
        view: "models" as const,
        page: 1,
        totalPages: 1,
        filter: "all" as const,
        freeCount: 0,
        totalCount: 0,
      })),
    getProviders: input.getProviders ?? (async () => []),
    getProviderModels:
      input.getProviderModels ?? (async () => ({ models: [], total: 0 })),
    formatModelError: input.formatModelError ?? (() => ""),
    listModels: input.listModels ?? (async () => ({ models: [], total: 0 })),
  };
}

function buildBackground(
  input: StubBackendInput,
): BackgroundRunner | undefined {
  if (input.background) return input.background;
  if (!input.runOneShotAgent && !input.evictOrphanSubprocesses)
    return undefined;
  return {
    runOneShotAgent: input.runOneShotAgent ?? (async () => undefined),
    evictOrphanSubprocesses: input.evictOrphanSubprocesses,
  };
}

function buildSessions(input: StubBackendInput): SessionBackend | undefined {
  if (input.sessions) return input.sessions;
  if (!input.resetChat && !input.warmSession) return undefined;
  return {
    resetChat: input.resetChat ?? (() => undefined),
    warmSession: input.warmSession,
  };
}

function buildTools(input: StubBackendInput): ToolRuntime | undefined {
  if (input.tools) return input.tools;
  if (!input.refreshMcpServers) return undefined;
  return { refreshTools: input.refreshMcpServers };
}

function buildUsage(input: StubBackendInput): UsageTelemetry | undefined {
  if (input.usage) return input.usage;
  if (!input.getSessionSnapshot) return undefined;
  return { getSessionSnapshot: input.getSessionSnapshot };
}

function buildControl(input: StubBackendInput): SystemControl | undefined {
  if (input.control) return input.control;
  if (!input.updateSystemPrompt) return undefined;
  return { updateSystemPrompt: input.updateSystemPrompt };
}

/**
 * Build a stub `Backend`. Any combination of legacy-shaped methods
 * is composed onto the corresponding capability slots. The `query`
 * field is wrapped through `handlerToEvents` to satisfy the new
 * `ChatBackend.runChatTurn` contract.
 */
export function stubBackend(input: StubBackendInput = {}): Backend {
  const id = input.id ?? "claude";
  const label = input.label ?? id;
  const query = input.query ?? defaultQuery;
  const chat: ChatBackend = input.chat ?? {
    runChatTurn: (params) => handlerToEvents(query, params),
  };
  return composeBackend({
    id,
    label,
    cacheMetrics: input.cacheMetrics ?? "none",
    chat,
    background: buildBackground(input),
    models: buildModels(input),
    sessions: buildSessions(input),
    tools: buildTools(input),
    usage: buildUsage(input),
    control: buildControl(input),
  });
}

/**
 * Convenience: stub a `Backend` whose `chat.runChatTurn` yields the
 * events a single canned `QueryResult` would produce. Returns both
 * the backend AND the underlying mock query function so the test
 * can assert on call history.
 */
export function stubChatBackend(result: Partial<QueryResult> = {}): {
  backend: Backend;
  query: ReturnType<typeof vi.fn>;
} {
  const fullResult: QueryResult = {
    text: result.text ?? "stub",
    durationMs: result.durationMs ?? 0,
    inputTokens: result.inputTokens ?? 0,
    outputTokens: result.outputTokens ?? 0,
    cacheRead: result.cacheRead ?? 0,
    cacheWrite: result.cacheWrite ?? 0,
  };
  const query = vi.fn(async () => fullResult);
  const backend = stubBackend({ query });
  return { backend, query };
}

/**
 * Default `resolveActiveModel` stub for the dispatcher. Returns a
 * bare `ModelRef` against the supplied backend id so the
 * dispatcher's send-time null-model guard passes. Tests that want
 * to exercise the no-model path supply their own stub.
 */
export function stubResolveActiveModel(
  backendId: BackendId = "claude",
  modelId = "stub-model",
) {
  return async () => ({
    model: modelId,
    ref: makeBareModelRef(backendId, modelId, "discovered"),
    backendId: backendId as string,
  });
}
