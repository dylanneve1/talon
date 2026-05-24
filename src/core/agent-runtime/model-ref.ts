/**
 * Structured model identity.
 *
 * Pre-`ModelRef`, the model was a naked string passed through config,
 * chat settings, backend defaults, discovered catalogs, auth rules,
 * and runtime learning. Every consumer rebuilt its own metadata
 * (context window, effort levels, free-tier flag, display name)
 * from scratch — or, more often, not at all.
 *
 * `ModelRef` is the one object every active run carries:
 * `{ backend, id }` is the routing pair the resolver chooses,
 * everything else is metadata so downstream code (UIs, `/status`,
 * logs, telemetry, tests) doesn't have to chase it down again.
 *
 * This module also pins the canonical `BackendId` union. Today the
 * config schema repeats the enum five times (`backend`,
 * `heartbeatBackend`, `dreamBackend`, `enabledBackends`, plus the
 * registry default). Phase 1 keeps both in lockstep manually —
 * `BACKEND_IDS` is the single literal source, the config zod enums
 * stay where they are. A later phase can wire config.ts to import
 * `BACKEND_IDS` directly.
 */

import type { ReasoningEffortLevel } from "../types.js";

/**
 * Canonical backend identifiers — must match `config.backend` zod
 * enum in `src/util/config.ts`. Update both sides together until
 * the enum is migrated to import this constant.
 */
export const BACKEND_IDS = [
  "claude",
  "codex",
  "kilo",
  "openai-agents",
  "opencode",
] as const;

export type BackendId = (typeof BACKEND_IDS)[number];

/**
 * Type guard that narrows arbitrary strings to `BackendId`. Use at
 * config parse boundaries and when reading values from external
 * sources (chat settings JSON, env vars).
 */
export function isBackendId(value: unknown): value is BackendId {
  return (
    typeof value === "string" &&
    (BACKEND_IDS as readonly string[]).includes(value)
  );
}

/**
 * Cache support levels. `none` hides cache UI entirely. `read` means
 * the backend can report cache reads but not writes (Codex on
 * ChatGPT OAuth). `readwrite` means both numbers are meaningful
 * (Claude SDK).
 */
export type CacheSupport = "none" | "read" | "readwrite";

/**
 * Where the resolver picked this model from. Mirrors
 * `ActiveModelSource` in `core/active-model.ts` so the two systems
 * can talk in the same vocabulary once Phase 2 lands. Values are
 * stable for logging and toast wording.
 */
export type ModelSource =
  | "config"
  | "chat"
  | "backend-default"
  | "discovered"
  | "fallback"
  | "unknown";

/**
 * One canonical model identity for an active run.
 *
 * Identity = `(backend, id)`. Two `ModelRef`s with the same identity
 * refer to the same runtime model even if their `displayName`,
 * `contextWindow`, or `effortLevels` were populated from different
 * catalogs.
 */
export interface ModelRef {
  /** Owning backend. */
  backend: BackendId;
  /** Backend-scoped model identifier. */
  id: string;
  /** Human-readable label for UI. Falls back to `id` when absent. */
  displayName: string;
  /** Underlying provider, when meaningful (`"anthropic"`, `"openrouter"`, `"openai"`). */
  provider?: string;
  /** Where the resolver chose this from — for logging + toasts. */
  source: ModelSource;
  /** Context window in tokens, when the backend exposes it. */
  contextWindow?: number;
  /** Reasoning levels the backend will accept for this model. */
  effortLevels?: readonly ReasoningEffortLevel[];
  /** Default effort level the backend will use if none is passed. */
  defaultEffort?: ReasoningEffortLevel;
  /** Prompt-cache support. */
  cacheSupport: CacheSupport;
  /** Whether the user is allowed to select this model in `/model`. */
  selectable: boolean;
  /** Whether the model is free-tier on its provider, when known. */
  free?: boolean;
  /** Why `selectable === false`. */
  unavailableReason?: string;
}

/**
 * Equality on identity only — two refs are the same run if they
 * point at the same backend + id.
 */
export function sameModelRef(a: ModelRef, b: ModelRef): boolean {
  return a.backend === b.backend && a.id === b.id;
}

/**
 * Bare-minimum constructor for tests and adapters that don't yet
 * carry rich metadata. Real catalog code should populate the
 * optional fields rather than rely on this default.
 */
export function makeBareModelRef(
  backend: BackendId,
  id: string,
  source: ModelSource = "unknown",
): ModelRef {
  return {
    backend,
    id,
    displayName: id,
    source,
    cacheSupport: "none",
    selectable: true,
  };
}
