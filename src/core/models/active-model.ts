/**
 * Active-model resolution for a chat.
 *
 * The single source of truth for "what model is this chat actually
 * running on right now?". Every display path (model menu, status,
 * post-callback toast) and every send-time guard routes through here
 * so display, persisted state, and the model handed to the backend
 * agree.
 *
 * Why this module exists
 * ──────────────────────
 *
 * Pre-refactor, callers read `chatSettings.model ?? config.model` —
 * a single global-default fallback that ignored the per-chat backend.
 * That produced two recurring bug classes:
 *
 *   1. **Reset-on-non-default-backend** (Dylan, 2026-05-21): chat on
 *      Codex, user hits Reset, code clears the override, read side
 *      returns `config.model = "claude-opus-4-7"`. Codex chat then
 *      tries to run an Anthropic id.
 *
 *   2. **Cross-backend orphan** (2026-05-19): a chat stores a model
 *      that's only valid on backend X, then gets switched to backend
 *      Y. The stored value is honored without validation; Y rejects
 *      it on every turn.
 *
 * Both are solved by (a) storing model picks per-backend and (b)
 * walking an explicit 5-step resolution chain at every read. This
 * module is the chain.
 *
 * Resolution order
 * ────────────────
 *
 * For a chat C on backend B:
 *
 *   1. `modelByBackend[B]` — per-chat-per-backend pick, if it still
 *      validates against B's catalog. Cross-backend orphans surface
 *      as `kind: "missing"` and fall through.
 *   2. `backend.models?.getDefaultModelId()` — backend's canonical default.
 *      Codex picks auth-aware (`gpt-5-codex` on API key, `gpt-5.5`
 *      on ChatGPT OAuth). Claude SDK returns the `"default"` alias.
 *      Stock OpenAI Agents returns a constant.
 *      Catalog-driven backends without a canonical (Kilo, OpenCode,
 *      OpenAI Agents on OpenRouter / custom OpenAI-compatible) do
 *      NOT implement this — they fall through to step 3.
 *   3. `config.backendDefaults[B]` — operator-configured per-backend
 *      default in `talon.json`. Escape hatch for "no canonical"
 *      backends.
 *   4. `config.model` — only when B is the global chat-role backend
 *      (`config.backend === B`). Back-compat for installs that
 *      predate `backendDefaults`.
 *   5. `null` → UI renders "No model selected", send guard refuses
 *      with a "use /model to pick one" reply.
 *
 * Validation step: when step 1 has a candidate, `backend.models?.resolveModelInfo`
 * is called. Only `kind: "exact"` with `selectable: true` honours the
 * stored override. Anything else falls through to step 2.
 *
 * Backends with no `resolveModel` (rare — defensive fallback only)
 * have their stored override returned verbatim — no way to validate.
 */

import {
  getChatModelForBackend,
  getChatSettings,
} from "../../storage/chat-settings.js";
import type { Backend } from "../agent-runtime/capabilities.js";
import {
  isBackendId,
  makeBareModelRef,
  type CacheSupport,
  type ModelRef,
  type ModelSource,
} from "../agent-runtime/model-ref.js";
import type { UnifiedModelInfo } from "../types.js";
import type { TalonConfig } from "../../util/config.js";
import { logWarn } from "../../util/log.js";

/**
 * Reasons `resolveActiveModelForChat` chose its returned value.
 * Surfaced for tests and toast wording — callers can label "Model: X
 * (default)" vs "Model: X (override)" vs "No model selected" without
 * second-guessing the chain.
 */
export type ActiveModelSource =
  | "override-valid"
  | "override-invalid-fallback"
  | "backend-canonical"
  | "config-backend-defaults"
  | "config-legacy-global"
  | "none";

export interface ActiveModelResolution {
  /**
   * Resolved model id from the 5-step chain, or `null` when the
   * chain produced no usable default. The dispatcher / send guard
   * compare against `null` to decide whether the chat has a model
   * to run on.
   */
  model: string | null;
  /**
   * Enriched `ModelRef` for the same model — `null` either when
   * `model === null` OR when the supplied `backendId` is not a
   * known `BackendId` (so a typed ref can't be constructed).
   * `/status`, `/model` chrome, and telemetry read the ref's
   * metadata fields (displayName, contextWindow, cacheSupport).
   */
  ref: ModelRef | null;
  source: ActiveModelSource;
}

/**
 * Resolve the model a chat should use on the given backend, validating
 * against the backend's catalog.
 *
 *   - `backend` is the per-chat backend from `resolveChatBackend()`.
 *     Pass `null` when no backend is bound — the resolver falls back
 *     to `config.model` (with source `config-legacy-global`) if set,
 *     else returns `null`.
 *
 *   - `backendId` is the id of the backend (`"codex"`, `"claude"`,
 *     etc) — needed for the `modelByBackend` slot lookup and for
 *     `config.backendDefaults[backendId]`. Pass `null` to skip the
 *     per-backend lookup entirely.
 */
export async function resolveActiveModelForChat(
  chatId: string,
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<ActiveModelResolution> {
  const stringPart = await runChain(chatId, backend, backendId, config);
  return {
    ...stringPart,
    ref: await materialiseRef(stringPart.model, backend, backendId),
  };
}

async function runChain(
  chatId: string,
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<{ model: string | null; source: ActiveModelSource }> {
  // ── Step 1: per-chat-per-backend override ────────────────────────
  if (backendId) {
    const override = getChatModelForBackend(chatId, backendId);
    if (override) {
      const validated = await validateModelOnBackend(backend, override);
      if (validated) {
        return { model: override, source: "override-valid" };
      }
      logWarn(
        "settings",
        `chat=${chatId} backend=${backendId}: per-chat override ` +
          `"${override}" is not a selectable model on this backend. ` +
          `Falling through to backend default.`,
      );
      return stepsTwoThroughFive(
        backend,
        backendId,
        config,
        "override-invalid-fallback",
      );
    }
  }

  // ── Step 2-5: backend canonical → config.backendDefaults →
  //              config.model (chat-role only) → null
  return stepsTwoThroughFive(backend, backendId, config, null);
}

async function stepsTwoThroughFive(
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
  fallbackSourceOverride: "override-invalid-fallback" | null,
): Promise<{ model: string | null; source: ActiveModelSource }> {
  // Step 2: backend.models.getDefaultModelId()
  if (backend?.models) {
    const canonical = await safeBackendDefault(backend);
    if (canonical) {
      return {
        model: canonical,
        source: fallbackSourceOverride ?? "backend-canonical",
      };
    }
  }

  // Step 3: config.backendDefaults[backendId]
  if (backendId && config.backendDefaults) {
    const operatorDefault = config.backendDefaults[backendId];
    if (operatorDefault && operatorDefault.length > 0) {
      return {
        model: operatorDefault,
        source: fallbackSourceOverride ?? "config-backend-defaults",
      };
    }
  }

  // Step 4: legacy config.model — only for the global chat-role backend
  if (
    backendId &&
    backendId === config.backend &&
    typeof config.model === "string" &&
    config.model.length > 0
  ) {
    return {
      model: config.model,
      source: fallbackSourceOverride ?? "config-legacy-global",
    };
  }

  // Step 4b: even without a backendId, honour config.model if no
  // backend is bound at all (callers passing null for both — rare,
  // typically pre-bootstrap code paths).
  if (
    !backendId &&
    typeof config.model === "string" &&
    config.model.length > 0
  ) {
    return {
      model: config.model,
      source: fallbackSourceOverride ?? "config-legacy-global",
    };
  }

  // Step 5: null. Callers must render "No model selected" / refuse send.
  return { model: null, source: "none" };
}

async function validateModelOnBackend(
  backend: Backend | null,
  modelId: string,
): Promise<boolean> {
  if (!backend?.models?.resolveModelInfo) {
    // No catalog to validate against — trust the stored value.
    return true;
  }
  try {
    const resolution = await backend.models.resolveModelInfo(modelId);
    return resolution.kind === "exact" && resolution.model.selectable;
  } catch (err) {
    logWarn(
      "settings",
      `models.resolveModelInfo threw while validating "${modelId}": ` +
        `${err instanceof Error ? err.message : String(err)}. Treating as ` +
        `invalid and falling through.`,
    );
    return false;
  }
}

async function safeBackendDefault(backend: Backend): Promise<string | null> {
  if (!backend.models?.getDefaultModelId) return null;
  try {
    const v = await backend.models.getDefaultModelId();
    if (typeof v === "string" && v.length > 0) return v;
    return null;
  } catch (err) {
    logWarn(
      "settings",
      `backend.models.getDefaultModelId threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * Convenience: same as `resolveActiveModelForChat` but returns just
 * the model id (or `null`). Use when the source tag isn't needed.
 */
export async function getActiveModelForChat(
  chatId: string,
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<string | null> {
  const { model } = await resolveActiveModelForChat(
    chatId,
    backend,
    backendId,
    config,
  );
  return model;
}

/**
 * Convenience: same as `resolveActiveModelForChat` but returns just
 * the `ModelRef` (or `null`). Use when the source tag isn't needed.
 */
export async function getActiveModelRefForChat(
  chatId: string,
  backend: Backend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<ModelRef | null> {
  const { ref } = await resolveActiveModelForChat(
    chatId,
    backend,
    backendId,
    config,
  );
  return ref;
}

// ── ref enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich the resolved model id into a `ModelRef`. Returns `null`
 * either when there's no model OR when the backendId isn't a known
 * `BackendId` (e.g. legacy config pointed at an unrecognised
 * backend). Tries the catalog's `getRawModelInfo` first, falls
 * through to `resolveModelInfo`, finally falls back to a bare ref.
 */
async function materialiseRef(
  modelId: string | null,
  backend: Backend | null,
  backendId: string | null,
): Promise<ModelRef | null> {
  if (!modelId) return null;
  if (!backendId || !isBackendId(backendId)) return null;
  const cacheSupport: CacheSupport = mapCacheSupport(backend);

  const catalog = backend?.models;
  if (catalog) {
    try {
      const info = await catalog.getRawModelInfo(modelId);
      if (info) return unifiedToModelRef(info, backendId, cacheSupport);
    } catch (err) {
      logWarn(
        "settings",
        `materialiseRef: getRawModelInfo("${modelId}") threw: ` +
          `${err instanceof Error ? err.message : String(err)}. Falling ` +
          `through to resolveModelInfo.`,
      );
    }
    try {
      const resolution = await catalog.resolveModelInfo(modelId);
      if (resolution.kind === "exact") {
        return unifiedToModelRef(resolution.model, backendId, cacheSupport);
      }
    } catch (err) {
      logWarn(
        "settings",
        `materialiseRef: resolveModelInfo("${modelId}") threw: ` +
          `${err instanceof Error ? err.message : String(err)}. Falling ` +
          `through to bare ref.`,
      );
    }
  }

  const bare = makeBareModelRef(backendId, modelId, "unknown");
  return { ...bare, cacheSupport };
}

function unifiedToModelRef(
  info: UnifiedModelInfo,
  backend: import("../agent-runtime/model-ref.js").BackendId,
  cache: CacheSupport,
): ModelRef {
  return {
    backend,
    id: info.id,
    displayName: info.displayName ?? info.id,
    provider: info.provider,
    source: "discovered" satisfies ModelSource,
    contextWindow: info.contextWindow,
    effortLevels: info.supportedReasoningLevels,
    defaultEffort: info.defaultReasoningLevel,
    cacheSupport: cache,
    selectable: info.selectable,
    free: info.free,
    unavailableReason: info.unavailableReason,
  };
}

function mapCacheSupport(backend: Backend | null): CacheSupport {
  switch (backend?.cacheMetrics) {
    case "read":
      return "read";
    case "readwrite":
      return "readwrite";
    case "none":
    case undefined:
      return "none";
  }
}

/**
 * Human-readable label for the source — used in toast wording so the
 * user sees *why* the resolved model is what it is. Keeps the wording
 * centralised so the UI stays consistent across frontends.
 */
export function describeActiveModelSource(source: ActiveModelSource): string {
  switch (source) {
    case "override-valid":
      return "your pick";
    case "override-invalid-fallback":
      return "previous pick invalid — falling back to default";
    case "backend-canonical":
      return "backend default";
    case "config-backend-defaults":
      return "configured default";
    case "config-legacy-global":
      return "global default";
    case "none":
      return "no model selected";
  }
}

/** Read-only helper to surface the `modelByBackend` map for a chat
 *  (e.g. for /status rendering). Returns a shallow copy. */
export function getModelByBackendSnapshot(
  chatId: string,
): Record<string, string> {
  const settings = getChatSettings(chatId);
  return { ...settings.modelByBackend };
}
