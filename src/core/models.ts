/**
 * Model registry — single source of truth for available models.
 *
 * Backends register their models during initialization. Frontends read
 * from the registry to build dynamic model pickers, resolve aliases,
 * and query capabilities. No model names are hardcoded outside this
 * system and the backend-specific model definition files.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ModelTier = "premium" | "balanced" | "economy";

export type ModelCapabilities = {
  /** Whether the model supports the 1M token context window. */
  supports1mContext: boolean;
  /** Exact model ID to use for the 1M token context window, if available. */
  oneMillionContextModelId?: string;
};

export type ModelInfo = {
  /** Canonical SDK model ID (e.g. "default", "opus", "sonnet[1m]"). */
  id: string;
  /** Human-readable display name for UIs (e.g. "Sonnet 4.6"). */
  displayName: string;
  /** Short description for setup wizard (e.g. "fast, balanced"). */
  description?: string;
  /** Aliases that resolve to this model (e.g. ["sonnet", "sonnet-4.6"]). */
  aliases: string[];
  /** Provider identifier (e.g. "anthropic", "openai"). */
  provider: string;
  /** Model capabilities used for backend configuration. */
  capabilities: ModelCapabilities;
  /** Tier for UI grouping and fallback ordering. */
  tier: ModelTier;
  /** Model to fall back to on overload/timeout. */
  fallback?: string;
};

// ── Tier sort order ─────────────────────────────────────────────────────────

const TIER_ORDER: Record<ModelTier, number> = {
  premium: 0,
  balanced: 1,
  economy: 2,
};

// ── Registry state ──────────────────────────────────────────────────────────

const models = new Map<string, ModelInfo>();
const aliasIndex = new Map<string, string>();

function resolveGenericFamilyAlias(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  const isOneMillion = trimmed.endsWith("[1m]");
  let base = isOneMillion ? trimmed.slice(0, -4) : trimmed;
  if (base.startsWith("claude-")) {
    base = base.slice("claude-".length);
  }

  const tokens = base.replace(/\./g, "-").split("-").filter(Boolean);
  if (tokens.length === 0) return null;

  let boundary = tokens.length;
  while (boundary > 0 && /^\d+$/.test(tokens[boundary - 1] ?? "")) {
    boundary -= 1;
  }

  const family = tokens.slice(
    0,
    boundary === tokens.length ? tokens.length : boundary,
  );
  if (family.length === 0) return null;

  const alias = family.join("-");
  return isOneMillion ? `${alias}[1m]` : alias;
}

// ── Registration ────────────────────────────────────────────────────────────

/** Register one or more models. Idempotent — re-registration overwrites. */
export function registerModels(infos: ModelInfo[]): void {
  for (const info of infos) {
    // Clear stale aliases from any previous registration of this model ID
    const prev = models.get(info.id);
    if (prev) {
      aliasIndex.delete(prev.id.toLowerCase());
      for (const alias of prev.aliases) {
        aliasIndex.delete(alias.toLowerCase());
      }
    }
    models.set(info.id, info);
    // Index the canonical ID itself as an alias
    aliasIndex.set(info.id.toLowerCase(), info.id);
    for (const alias of info.aliases) {
      aliasIndex.set(alias.toLowerCase(), info.id);
    }
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────

/** Get a model by canonical ID. */
export function getModel(id: string): ModelInfo | undefined {
  return models.get(id);
}

/** List all registered models, optionally filtered by provider. Sorted by tier. */
export function getModels(provider?: string): ModelInfo[] {
  let result = [...models.values()];
  if (provider) {
    result = result.filter((m) => m.provider === provider);
  }
  return result.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
}

/**
 * Resolve a user input (alias or full ID) to the canonical model ID.
 * Returns the input unchanged if no match is found (passthrough for
 * unknown/custom model names).
 */
export function resolveModelId(input: string): string {
  const lower = input.trim().toLowerCase();
  const direct = aliasIndex.get(lower);
  if (direct) return direct;

  const genericAlias = resolveGenericFamilyAlias(input);
  if (genericAlias) {
    const resolved = aliasIndex.get(genericAlias);
    if (resolved) return resolved;
  }

  return input.trim();
}

/**
 * Resolve a user input to the full ModelInfo, or undefined if not found.
 */
export function resolveModel(input: string): ModelInfo | undefined {
  const id = resolveModelId(input);
  return models.get(id);
}

/** Get the fallback model ID for a given model, or null if none configured. */
export function getFallbackModel(modelId: string): string | null {
  return resolveModel(modelId)?.fallback ?? null;
}

/** Check whether a model supports the 1M token context window. */
export function supports1mContext(modelId: string): boolean {
  const info = resolveModel(modelId);
  // Default to true for unknown models (don't restrict capabilities we can't check)
  return info?.capabilities.supports1mContext ?? true;
}

/** Resolve the exact 1M-context model ID for a given model, if one exists. */
export function get1mContextModelId(modelId: string): string | null {
  return resolveModel(modelId)?.capabilities.oneMillionContextModelId ?? null;
}

/**
 * Get the default model for a given tier. Returns the first registered model
 * matching the tier, or the first model overall, or the hardcoded fallback.
 */
export function getDefaultModel(tier: ModelTier = "balanced"): string {
  const byTier = [...models.values()].find((m) => m.tier === tier);
  if (byTier) return byTier.id;
  const first = models.values().next();
  if (!first.done) return first.value.id;
  return "default"; // ultimate fallback if the registry is still empty
}

// ── Provider-scoped clearing ────────────────────────────────────────────────

/** Remove all models for a specific provider (and their aliases). */
export function clearModelsByProvider(provider: string): void {
  for (const [id, info] of models) {
    if (info.provider !== provider) continue;
    aliasIndex.delete(id.toLowerCase());
    for (const alias of info.aliases) {
      aliasIndex.delete(alias.toLowerCase());
    }
    models.delete(id);
  }
}

/** Clear the entire registry. For tests only. */
export function clearModels(): void {
  models.clear();
  aliasIndex.clear();
}
