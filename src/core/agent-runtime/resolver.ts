/**
 * `resolveActiveModelRef` — the `ModelRef`-shaped counterpart to
 * `core/active-model.ts`'s `resolveActiveModelForChat`.
 *
 * Phase 2 of the architecture unification plan introduces this
 * function but does **not** migrate any callers. The existing 5-step
 * string-shaped resolver stays the single chain-of-truth — this
 * module wraps it and enriches the returned id into a `ModelRef`
 * carrying the metadata downstream consumers (`/status` rendering,
 * `/model` menu chrome, telemetry) currently re-derive on the spot.
 *
 * Migration order (per the plan):
 *
 *   1. Phase 2.1 (this PR) — add the function + tests, no caller
 *      migration. Production behaviour unchanged.
 *   2. Phase 2.2+ — convert `/status`, `/model`, chat query,
 *      heartbeat, dream one or two at a time, each in its own PR.
 *
 * Enrichment strategy
 * ───────────────────
 *
 * After the 5-step chain hands back `{ model: id, source }`:
 *
 *   - If `backend.getModelInfo(id)` is available and returns a match,
 *     map `UnifiedModelInfo` → `ModelRef` (full metadata).
 *   - Else if `backend.resolveModel(id)` returns `kind: "exact"`,
 *     map its `model` the same way.
 *   - Else fall back to `makeBareModelRef(backend, id)` so the caller
 *     still gets the identity pair.
 *
 * `cacheSupport` is propagated from the backend's `cacheMetrics`
 * field onto every ref the resolver produces — backends report
 * caching uniformly across their catalog today, so this is the right
 * place to stamp it.
 *
 * `ActiveModelSource → ModelSource` mapping
 * ─────────────────────────────────────────
 *
 *   override-valid             → "chat"             (per-chat override)
 *   override-invalid-fallback  → "fallback"         (chain fell through)
 *   backend-canonical          → "backend-default"  (backend.getDefaultModel)
 *   config-backend-defaults    → "config"           (operator override)
 *   config-legacy-global       → "config"           (legacy config.model)
 *   none                       → (ref is null)
 *
 * Invariants
 * ──────────
 *
 *   - `ref === null` iff the 5-step chain returned `model === null`
 *     OR the supplied `backendId` is not a known `BackendId`.
 *   - `source` is always returned verbatim from the underlying chain
 *     so callers can use the same toast wording in both APIs.
 */

import {
  resolveActiveModelForChat,
  type ActiveModelResolution,
  type ActiveModelSource,
} from "../active-model.js";
import type { QueryBackend } from "../types.js";
import type { TalonConfig } from "../../util/config.js";
import { logWarn } from "../../util/log.js";
import {
  isBackendId,
  makeBareModelRef,
  type BackendId,
  type CacheSupport,
  type ModelRef,
  type ModelSource,
} from "./model-ref.js";
import type { UnifiedModelInfo } from "../types.js";

export interface ActiveModelRefResolution {
  /** Resolved `ModelRef`, or `null` when the chain produced no model. */
  ref: ModelRef | null;
  source: ActiveModelSource;
}

/**
 * Resolve the active model for a chat as a `ModelRef`, enriched with
 * whatever metadata the backend's catalog exposes.
 *
 * Arguments mirror `resolveActiveModelForChat` so callers can swap
 * one for the other without restructuring their call sites.
 */
export async function resolveActiveModelRefForChat(
  chatId: string,
  backend: QueryBackend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<ActiveModelRefResolution> {
  const stringResolution: ActiveModelResolution =
    await resolveActiveModelForChat(chatId, backend, backendId, config);

  if (!stringResolution.model) {
    return { ref: null, source: stringResolution.source };
  }

  // The chain can produce a model id without a backendId (the
  // pre-bootstrap `config.model` fallback). Without a known
  // BackendId we can't construct a typed ref — return null and let
  // callers keep using the string API for those cases.
  if (!backendId || !isBackendId(backendId)) {
    return { ref: null, source: stringResolution.source };
  }

  const cacheSupport: CacheSupport = mapCacheSupport(backend);
  const modelSource = mapSource(stringResolution.source);

  const enriched = await enrichRef(
    backend,
    backendId,
    stringResolution.model,
    cacheSupport,
    modelSource,
  );

  return { ref: enriched, source: stringResolution.source };
}

/**
 * Convenience: same as above but returns just the `ModelRef` (or
 * `null`). Use when the source tag isn't needed at the call site.
 */
export async function getActiveModelRefForChat(
  chatId: string,
  backend: QueryBackend | null,
  backendId: string | null,
  config: TalonConfig,
): Promise<ModelRef | null> {
  const { ref } = await resolveActiveModelRefForChat(
    chatId,
    backend,
    backendId,
    config,
  );
  return ref;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function enrichRef(
  backend: QueryBackend | null,
  backendId: BackendId,
  modelId: string,
  cacheSupport: CacheSupport,
  source: ModelSource,
): Promise<ModelRef> {
  if (backend?.getModelInfo) {
    try {
      const info = await backend.getModelInfo(modelId);
      if (info) {
        return unifiedToModelRef(info, backendId, cacheSupport, source);
      }
    } catch (err) {
      logWarn(
        "settings",
        `resolveActiveModelRefForChat: getModelInfo("${modelId}") threw: ` +
          `${err instanceof Error ? err.message : String(err)}. Falling ` +
          `through to resolveModel.`,
      );
    }
  }

  if (backend?.resolveModel) {
    try {
      const resolution = await backend.resolveModel(modelId);
      if (resolution.kind === "exact") {
        return unifiedToModelRef(
          resolution.model,
          backendId,
          cacheSupport,
          source,
        );
      }
    } catch (err) {
      logWarn(
        "settings",
        `resolveActiveModelRefForChat: resolveModel("${modelId}") threw: ` +
          `${err instanceof Error ? err.message : String(err)}. Falling ` +
          `through to bare ref.`,
      );
    }
  }

  // No catalog metadata available — return a bare ref with the
  // backend-wide cache support stamped in.
  const bare = makeBareModelRef(backendId, modelId, source);
  return { ...bare, cacheSupport };
}

function unifiedToModelRef(
  info: UnifiedModelInfo,
  backend: BackendId,
  cache: CacheSupport,
  source: ModelSource,
): ModelRef {
  return {
    backend,
    id: info.id,
    displayName: info.displayName ?? info.id,
    provider: info.provider,
    source,
    contextWindow: info.contextWindow,
    effortLevels: info.supportedReasoningLevels,
    defaultEffort: info.defaultReasoningLevel,
    cacheSupport: cache,
    selectable: info.selectable,
    free: info.free,
    unavailableReason: info.unavailableReason,
  };
}

function mapCacheSupport(backend: QueryBackend | null): CacheSupport {
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
 * Translate the existing string-side source enum into the
 * `ModelRef.source` enum. The mapping is intentionally lossy on the
 * fallback side — the new shape doesn't distinguish "operator
 * default" from "legacy global default" because callers consuming
 * `ModelRef.source` care about provenance (chat vs config vs
 * backend) not about which slot in the chain produced it. The
 * `ActiveModelSource` tag returned alongside still carries the
 * fine-grained reason for toast wording.
 */
function mapSource(source: ActiveModelSource): ModelSource {
  switch (source) {
    case "override-valid":
      return "chat";
    case "override-invalid-fallback":
      return "fallback";
    case "backend-canonical":
      return "backend-default";
    case "config-backend-defaults":
      return "config";
    case "config-legacy-global":
      return "config";
    case "none":
      return "unknown";
  }
}
