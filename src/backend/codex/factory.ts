/**
 * Codex backend factory — wires the OpenAI Codex SDK into the registry.
 *
 * Returns the composed `Backend` shape directly: each capability slot
 * (chat, background, models, sessions, usage) is populated from the
 * handler / one-shot / catalog modules. No fat-optional
 * `QueryBackend` surface — the dispatcher and frontend consumers
 * read through slots.
 */

import { registerBackend } from "../registry.js";
import type { BackendFactory } from "../registry.js";
import { log } from "../../util/log.js";
import { toEventStream } from "../shared/to-event-stream.js";
import {
  composeBackend,
  type ChatBackend,
  type BackgroundRunner,
  type ModelCatalog,
  type SessionBackend,
} from "../../core/agent-runtime/capabilities.js";
import { makeBareModelRef } from "../../core/agent-runtime/model-ref.js";

import { initCodexAgent, getCodexAuthInfo } from "./init.js";
import { handleMessage as codexHandleMessage } from "./handler.js";
import { runOneShotAgent as codexRunOneShotAgent } from "./one-shot.js";
import { resetState as resetCodexState } from "./state.js";
import {
  CODEX_DEFAULT_MODEL,
  CODEX_CHATGPT_DEFAULT_MODEL,
} from "./constants.js";
import {
  resolveModel as codexResolveModel,
  getModelInfo as codexGetModelInfo,
  getSettingsPresentation as codexGetSettingsPresentation,
  getProviders as codexGetProviders,
  getProviderModels as codexGetProviderModels,
  formatModelError as codexFormatModelError,
  listModels as codexListModels,
} from "./models.js";

const codexFactory: BackendFactory = {
  id: "codex",
  label: "Codex",

  async init(config, ctx) {
    initCodexAgent(config, ctx.getBridgePort, ctx.frontendName);
    log("bot", "Backend: Codex (@openai/codex-sdk)");

    const chat: ChatBackend = {
      runChatTurn: (params) =>
        toEventStream((p) => codexHandleMessage(p), params),
    };

    const background: BackgroundRunner = {
      runOneShotAgent: (p) => codexRunOneShotAgent(p),
      // Codex spawns per-turn CLI subprocesses that the SDK reaps on its own
      // — no explicit orphan-eviction path needed here.
    };

    const models: ModelCatalog = {
      // ── ModelRef-shaped surface ────────────────────────────────────────
      async resolveModel(query) {
        const resolution = await codexResolveModel(query);
        if (resolution.kind === "exact") {
          return {
            kind: "exact",
            model: makeBareModelRef("codex", resolution.model.id),
            storedValue: resolution.storedValue,
          };
        }
        if (resolution.kind === "ambiguous") {
          return {
            kind: "ambiguous",
            matches: resolution.matches.map((m) =>
              makeBareModelRef("codex", m.id),
            ),
          };
        }
        return { kind: "missing" };
      },
      async listModels(filter) {
        const result = await codexListModels(filter.freeOnly ? "free" : "all");
        return {
          models: result.models.map((m) => makeBareModelRef("codex", m.id)),
          total: result.total,
        };
      },
      async getDefaultModel() {
        const auth = getCodexAuthInfo();
        const id =
          auth?.mode === "chatgpt"
            ? CODEX_CHATGPT_DEFAULT_MODEL
            : CODEX_DEFAULT_MODEL;
        return makeBareModelRef("codex", id, "backend-default");
      },
      async getModelInfo(id) {
        const info = await codexGetModelInfo(id);
        if (!info) return undefined;
        return makeBareModelRef("codex", info.id);
      },

      // ── UnifiedModelInfo-shaped surface ────────────────────────────────
      resolveModelInfo: (q) => codexResolveModel(q),
      getDefaultModelId: () => {
        const auth = getCodexAuthInfo();
        return auth?.mode === "chatgpt"
          ? CODEX_CHATGPT_DEFAULT_MODEL
          : CODEX_DEFAULT_MODEL;
      },
      getRawModelInfo: (id) => codexGetModelInfo(id),
      getSettingsPresentation: (m, options) =>
        codexGetSettingsPresentation(m, options),
      getProviders: () => codexGetProviders(),
      getProviderModels: (p, pg, ps) => codexGetProviderModels(p, pg, ps),
      formatModelError: (q, r) => codexFormatModelError(q, r),
      listModelsRaw: (f) => codexListModels(f),
    };

    // Codex backend has no separate sessions slot — its `handleMessage`
    // owns the per-chat thread lifecycle itself (via `setSessionId` on
    // `storage/sessions.ts`). The factory exposes a no-op `resetChat`
    // so the dispatcher can call it without conditional checks; the
    // shared `storage/sessions.ts:resetSession` path is what actually
    // clears the thread id when `/reset` fires.
    const sessions: SessionBackend = {
      resetChat: () => undefined,
    };

    const backend = composeBackend({
      id: "codex",
      label: "Codex",
      cacheMetrics: "read",
      chat,
      background,
      models,
      sessions,
    });

    return {
      backend,
      cleanup: () => {
        resetCodexState();
        log("bot", "Codex backend cleaned up");
      },
    };
  },
};

registerBackend(codexFactory);
