/**
 * Claude model discovery — queries the SDK for available models.
 *
 * Spawns a throwaway SDK subprocess, calls supportedModels(), and
 * registers the results in the global model registry. This is the
 * only source of truth for available Claude models — if the SDK
 * fails to provide models, initialization is aborted.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  registerModels,
  clearModelsByProvider,
  registerProviderPrefix,
} from "../../core/models.js";
import type { ModelInfo } from "../../core/models.js";
import { normalizeReasoningLevels } from "../../core/reasoning-levels.js";
import { log, logError } from "../../util/log.js";

type SdkModelInfo = {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  capabilities?: {
    effort?: {
      supported?: boolean;
      low?: { supported?: boolean } | null;
      medium?: { supported?: boolean } | null;
      high?: { supported?: boolean } | null;
      max?: { supported?: boolean } | null;
      xhigh?: { supported?: boolean } | null;
    } | null;
  } | null;
};

type ParsedModelIdentity = {
  family: string | null;
  version: string | null;
  claudeId: string | null;
  isOneMillion: boolean;
};

type SdkModelRecord = SdkModelInfo & {
  index: number;
  identity: ParsedModelIdentity;
  familyKey: string | null;
  variantKey: string | null;
};

// ── Tier / fallback inference ───────────────────────────────────────────────

const FAMILY_VERSION_PATTERN = /\b([A-Za-z][A-Za-z-]*)\s+(\d+(?:\.\d+)*)\b/;
const FAMILY_ONLY_PATTERN = /^\s*([A-Za-z][A-Za-z-]*)\b/;

function normalizeFamilyName(family: string): string {
  return family.trim().toLowerCase().replace(/\s+/g, "-");
}

function toDisplayFamilyName(family: string): string {
  return family
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Synthesize a clean label like "Sonnet 4.6" (or "Sonnet 4.6 (1M context)")
 * from parsed identity. Base and 1M variants get distinct labels so the picker
 * can list both — the de-dup by display name in the model provider relies on
 * this distinction to keep both entries.
 */
function deriveDisplayName(
  identity: ParsedModelIdentity,
  fallback: string,
): string {
  if (!identity.family) return fallback;
  const family = toDisplayFamilyName(identity.family);
  const version = identity.version ? ` ${identity.version}` : "";
  const suffix = identity.isOneMillion ? " (1M context)" : "";
  return `${family}${version}${suffix}`;
}

function stripOneMillionSuffix(value: string): string {
  return value.endsWith("[1m]") ? value.slice(0, -4) : value;
}

function toDashVersion(version: string): string {
  return version.replace(/\./g, "-");
}

function parseFamilyAndVersionFromTexts(
  texts: readonly string[],
): Pick<ParsedModelIdentity, "family" | "version"> {
  for (const text of texts) {
    const match = text.match(FAMILY_VERSION_PATTERN);
    if (!match) continue;
    return {
      family: normalizeFamilyName(match[1]),
      version: match[2],
    };
  }

  for (const text of texts) {
    const match = text.match(FAMILY_ONLY_PATTERN);
    if (!match) continue;
    const family = normalizeFamilyName(match[1]);
    if (family === "default") continue;
    return { family, version: null };
  }

  return { family: null, version: null };
}

function parseClaudeId(
  value: string,
): Pick<ParsedModelIdentity, "family" | "version" | "claudeId"> {
  const claudeId = stripOneMillionSuffix(value);
  if (!claudeId.startsWith("claude-")) {
    return { family: null, version: null, claudeId: null };
  }

  const tokens = claudeId.slice("claude-".length).split("-");
  let boundary = tokens.length;
  while (boundary > 0 && /^\d+$/.test(tokens[boundary - 1] ?? "")) {
    boundary -= 1;
  }

  const familyTokens = tokens.slice(0, boundary);
  const versionTokens = tokens.slice(boundary);

  return {
    family:
      familyTokens.length > 0
        ? normalizeFamilyName(familyTokens.join("-"))
        : null,
    version: versionTokens.length > 0 ? versionTokens.join(".") : null,
    claudeId,
  };
}

/**
 * Detect whether a model is a 1M-context variant. The SDK signals this in two
 * ways: the canonical `[1m]` value suffix (e.g. `claude-sonnet-4-6[1m]`), or —
 * for the recommended `default` alias — only in prose ("…with 1M context…").
 * Catching both keeps a description-only 1M model from masquerading as a
 * separate base entry alongside its longhand `[1m]` duplicate.
 */
function detectOneMillion(model: SdkModelInfo): boolean {
  if (model.value.endsWith("[1m]")) return true;
  const text =
    `${model.description ?? ""} ${model.displayName ?? ""}`.toLowerCase();
  return /\b1m\b/.test(text) && text.includes("context");
}

function describeSdkModel(model: SdkModelInfo): ParsedModelIdentity {
  const textIdentity = parseFamilyAndVersionFromTexts([
    model.description,
    model.displayName,
    model.value,
  ]);
  const claudeIdentity = parseClaudeId(model.value);
  const family = textIdentity.family ?? claudeIdentity.family;
  const version = textIdentity.version ?? claudeIdentity.version;

  return {
    family,
    version,
    claudeId:
      claudeIdentity.claudeId ??
      (family && version ? `claude-${family}-${toDashVersion(version)}` : null),
    isOneMillion: detectOneMillion(model),
  };
}

function buildFamilyKey(identity: ParsedModelIdentity): string | null {
  return identity.family
    ? `${identity.family}:${identity.version ?? "*"}`
    : null;
}

/**
 * Variant key groups only *true* duplicates — same family, version, AND
 * context size. Base and 1M variants of one family+version land in separate
 * buckets so both surface in the picker, while redundant longhand ids (e.g.
 * `claude-opus-4-7[1m]` next to the `default` it mirrors) still collapse.
 */
function buildVariantKey(identity: ParsedModelIdentity): string | null {
  const familyKey = buildFamilyKey(identity);
  if (!familyKey) return null;
  return `${familyKey}:${identity.isOneMillion ? "1m" : "base"}`;
}

type AliasFormOptions = {
  /** Emit bare, unsuffixed forms ("fable", "fable-5", "claude-fable-5"). */
  includeBare: boolean;
  /** Emit `[1m]`-suffixed forms ("fable[1m]", "claude-fable-5[1m]"). */
  include1m: boolean;
};

/**
 * Generate resolution aliases for a model's identity.
 *
 * The caller decides which forms this entry owns:
 *  - A base entry owns the bare forms ("sonnet", "sonnet-4-6", …).
 *  - A 1M entry owns the `[1m]` forms; it additionally claims the bare forms
 *    only when no base sibling exists (e.g. Fable, shipped solely as
 *    `claude-fable-5[1m]`, must still resolve from "fable").
 *
 * Stems come from the family, the family+version (dot and dash spellings),
 * and the canonical claude-id, so both "fable-5" and "claude-fable-5" resolve.
 */
function buildGeneratedAliases(
  identity: ParsedModelIdentity,
  { includeBare, include1m }: AliasFormOptions,
): string[] {
  if (!identity.family) return [];

  const stems = [identity.family];

  if (identity.version) {
    stems.push(
      `${identity.family}-${identity.version}`,
      `${identity.family}-${toDashVersion(identity.version)}`,
    );
  }

  if (identity.claudeId) {
    stems.push(identity.claudeId);
  }

  const aliases: string[] = [];
  for (const stem of stems) {
    if (includeBare) aliases.push(stem);
    if (include1m) aliases.push(`${stem}[1m]`);
  }

  return aliases;
}

/**
 * Lower number = higher priority when choosing a canonical id among *true
 * duplicates* (records sharing family + version + context size):
 *   0 — "default"                      (SDK-recommended canonical)
 *   1 — short non-claude-prefixed      (e.g. sonnet, sonnet[1m])
 *   2 — claude-prefixed (legacy)       (e.g. claude-sonnet-4-6[1m])
 * The short alias wins over the longhand `claude-*` id so picker callbacks and
 * stored values stay compact.
 */
function getPreferredModelPriority(record: SdkModelRecord): number {
  if (record.value === "default") return 0;
  return record.value.startsWith("claude-") ? 2 : 1;
}

function buildSdkModelRecords(sdkModels: SdkModelInfo[]): SdkModelRecord[] {
  return sdkModels.map((model, index) => {
    const identity = describeSdkModel(model);
    return {
      ...model,
      index,
      identity,
      familyKey: buildFamilyKey(identity),
      variantKey: buildVariantKey(identity),
    };
  });
}

function mergeAliases(...lists: readonly string[][]): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];

  for (const list of lists) {
    for (const alias of list) {
      const key = alias.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      aliases.push(alias);
    }
  }

  return aliases;
}

// ── SDK → registry conversion ───────────────────────────────────────────────

function extractSdkReasoningLevels(model: SdkModelInfo) {
  if (model.supportsEffort === false) return [];

  const sdkLevels = normalizeReasoningLevels(model.supportedEffortLevels);
  if (sdkLevels.length > 0) return sdkLevels;

  const effort = model.capabilities?.effort;
  if (!effort?.supported) return [];

  return normalizeReasoningLevels(
    (["low", "medium", "high", "max", "xhigh"] as const).filter(
      (level) => effort[level]?.supported === true,
    ),
  );
}

/**
 * Group records into variant buckets and pick the canonical record for each.
 * Records without a parseable identity become their own singleton bucket so
 * they still surface (keyed by value to stay unique).
 */
function groupVariants(
  records: readonly SdkModelRecord[],
): Map<string, SdkModelRecord[]> {
  const groups = new Map<string, SdkModelRecord[]>();
  for (const record of records) {
    const key = record.variantKey ?? `raw:${record.value}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(record);
    groups.set(key, bucket);
  }
  return groups;
}

function pickCanonical(bucket: readonly SdkModelRecord[]): SdkModelRecord {
  return [...bucket].sort((left, right) => {
    const priorityDelta =
      getPreferredModelPriority(left) - getPreferredModelPriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    return left.index - right.index;
  })[0]!;
}

/**
 * Assign a best-effort fallback (used on overload/timeout) to every model
 * except the last:
 *  - A 1M variant prefers its base sibling of the same family+version.
 *  - Otherwise a model falls back to the next model in SDK order.
 */
function assignFallbacks(
  models: ModelInfo[],
  recordByValue: ReadonlyMap<string, SdkModelRecord>,
): void {
  const baseByFamily = new Map<string, string>();
  for (const model of models) {
    const rec = recordByValue.get(model.id);
    if (rec && !rec.identity.isOneMillion && rec.familyKey) {
      baseByFamily.set(rec.familyKey, model.id);
    }
  }

  models.forEach((model, index) => {
    const rec = recordByValue.get(model.id);
    if (rec?.identity.isOneMillion && rec.familyKey) {
      const baseSibling = baseByFamily.get(rec.familyKey);
      if (baseSibling && baseSibling !== model.id) {
        model.fallback = baseSibling;
        return;
      }
    }
    if (index < models.length - 1) {
      model.fallback = models[index + 1]!.id;
    }
  });
}

/**
 * Convert SDK ModelInfo to our registry format.
 *
 * Base and 1M variants of the same family+version each surface as their own
 * selectable entry (so the picker shows both), while true duplicates — the
 * same model exposed under multiple ids, e.g. the recommended `default` and
 * the longhand `claude-opus-4-7[1m]` it mirrors — collapse into one canonical
 * entry that absorbs the others' aliases. Display names, aliases, and the
 * fallback chain are all derived from SDK metadata, never hardcoded versions.
 */
function convertSdkModels(sdkModels: SdkModelInfo[]): ModelInfo[] {
  const records = buildSdkModelRecords(sdkModels);
  const groups = groupVariants(records);

  // One canonical per variant bucket, ordered by SDK position so the registry
  // preserves the SDK's ordering.
  const canonicals = [...groups.values()]
    .map(pickCanonical)
    .sort((a, b) => a.index - b.index);

  // Which family+version pairs have a base (non-1M) canonical? A 1M entry only
  // claims the bare family aliases when there is no base sibling to own them.
  const baseFamilyVersions = new Set<string>();
  for (const canonical of canonicals) {
    if (!canonical.identity.isOneMillion && canonical.familyKey) {
      baseFamilyVersions.add(canonical.familyKey);
    }
  }

  const usedKeys = new Set<string>();
  const recordByValue = new Map<string, SdkModelRecord>();
  const models: ModelInfo[] = [];

  for (const canonical of canonicals) {
    const groupKey = canonical.variantKey ?? `raw:${canonical.value}`;
    const bucket = groups.get(groupKey)!;
    const { identity } = canonical;

    const hasBaseSibling = identity.isOneMillion
      ? !!canonical.familyKey && baseFamilyVersions.has(canonical.familyKey)
      : true;
    const aliasForms: AliasFormOptions = {
      includeBare: !identity.isOneMillion || !hasBaseSibling,
      include1m: identity.isOneMillion,
    };

    // Aliases come from every record the canonical absorbs (its own value plus
    // each duplicate's value and generated forms), so legacy ids keep resolving.
    const canonicalKey = canonical.value.toLowerCase();
    const aliases = mergeAliases(
      ...bucket.map((record) => [
        record.value,
        ...buildGeneratedAliases(record.identity, aliasForms),
      ]),
    )
      .filter((alias) => alias.toLowerCase() !== canonicalKey)
      .filter((alias) => !usedKeys.has(alias.toLowerCase()));

    usedKeys.add(canonicalKey);
    for (const alias of aliases) usedKeys.add(alias.toLowerCase());

    recordByValue.set(canonical.value, canonical);
    models.push({
      id: canonical.value,
      displayName: deriveDisplayName(identity, canonical.displayName),
      description: canonical.description,
      aliases,
      provider: "anthropic",
      supportedReasoningLevels: extractSdkReasoningLevels(canonical),
    });
  }

  assignFallbacks(models, recordByValue);
  return models;
}

// ── Public API ──────────────────────────────────────────────────────────────

type ProbeOptions = {
  cwd?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
};

const DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_DISCOVERY_SEEDS = 8;

/**
 * The `claude` binary returns "Custom model" for a `model` it doesn't
 * recognise — it echoes the requested id straight back as a passthrough entry
 * with no real metadata. We drop those (except the user's own configured
 * model) so seed probing doesn't pollute the registry with junk families.
 */
const CUSTOM_MODEL_DESCRIPTION = "custom model";

/**
 * Spawn a throwaway SDK subprocess seeded with `seedModel` and return its
 * `supportedModels()` list. The binary always echoes the requested model into
 * the list, so the seed controls which models surface beyond the base set.
 */
async function probeSupportedModels(
  seedModel: string,
  probeOptions: ProbeOptions,
): Promise<SdkModelInfo[]> {
  const abort = new AbortController();
  let drainPromise: Promise<void> | undefined;

  try {
    const neverYield = async function* (): AsyncGenerator<never> {
      await new Promise<never>((_, reject) => {
        abort.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    };

    const q = query({
      prompt: neverYield(),
      options: {
        ...probeOptions,
        model: seedModel,
        abortController: abort,
      } as Parameters<typeof query>[0]["options"],
    });

    drainPromise = (async () => {
      try {
        for await (const _ of q) {
          /* discard */
        }
      } catch {
        /* expected on abort */
      }
    })();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new Error(
              `model discovery timed out after 15s (seed "${seedModel}")`,
            ),
          ),
        DISCOVERY_TIMEOUT_MS,
      );
    });

    try {
      return await Promise.race([q.supportedModels(), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      abort.abort();
      await drainPromise.catch(() => {});
    }
  } catch (err) {
    abort.abort();
    if (drainPromise) await drainPromise.catch(() => {});
    throw err;
  }
}

/**
 * Merge probe results into one list, first-occurrence-wins by value, dropping
 * unrecognised "Custom model" passthrough echoes (but always keeping the user's
 * configured model even if the binary treats it as custom).
 */
function unionSdkModels(
  lists: readonly SdkModelInfo[][],
  configuredModel: string,
): SdkModelInfo[] {
  const byValue = new Map<string, SdkModelInfo>();
  for (const list of lists) {
    for (const model of list) {
      if (byValue.has(model.value)) continue;
      const isPassthroughJunk =
        (model.description ?? "").trim().toLowerCase() ===
          CUSTOM_MODEL_DESCRIPTION && model.value !== configuredModel;
      if (isPassthroughJunk) continue;
      byValue.set(model.value, model);
    }
  }
  return [...byValue.values()];
}

/**
 * Discover available models from the Claude Agent SDK and register them.
 *
 * Discovery is a union of probes. The binary only echoes the *requested* model
 * (and a small base set) from `supportedModels()`, so a single probe misses
 * the base-vs-1M counterpart of most families. We therefore probe the
 * configured model first (mandatory — guarantees the user's choice is always
 * discoverable), then best-effort re-probe each real family alias it revealed,
 * and union the results so the picker reliably lists both context sizes of
 * every family. Throws only if the mandatory first probe fails — if the SDK
 * can't provide models, Talon cannot function.
 */
export async function registerClaudeModels(sdkOptions: {
  model: string;
  cwd?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
}): Promise<void> {
  const { model: configuredModel, ...probeOptions } = sdkOptions;

  try {
    // Pass 1 (mandatory): the configured model is always echoed back.
    const primary = await probeSupportedModels(configuredModel, probeOptions);
    if (primary.length === 0) {
      throw new Error("SDK returned empty model list");
    }

    // Pass 2 (best-effort): re-probe each real family alias from pass 1 to coax
    // out the context variants the first probe didn't echo. Bare family aliases
    // (e.g. "opus") return real metadata; unrecognised ones come back as
    // "Custom model" and are filtered by unionSdkModels.
    const seeds = new Set<string>();
    for (const model of primary) {
      const { family } = describeSdkModel(model);
      if (family && family !== "default") seeds.add(family);
    }
    seeds.delete(configuredModel);

    const seedList = [...seeds].slice(0, MAX_DISCOVERY_SEEDS);
    const secondary = await Promise.allSettled(
      seedList.map((seed) => probeSupportedModels(seed, probeOptions)),
    );
    const extraLists = secondary
      .filter(
        (result): result is PromiseFulfilledResult<SdkModelInfo[]> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value);

    const union = unionSdkModels([primary, ...extraLists], configuredModel);
    const models = convertSdkModels(union);
    clearModelsByProvider("anthropic");
    registerProviderPrefix("claude-");
    registerModels(models);
    log(
      "agent",
      `Discovered ${models.length} models from SDK ` +
        `(${1 + extraLists.length}/${1 + seedList.length} probes): ` +
        models.map((m) => m.id).join(", "),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("agent", `Fatal: model discovery failed — ${msg}`);
    throw new Error(
      `Claude SDK model discovery failed: ${msg}. ` +
        `Check that Claude Code is installed and your API key is valid.`,
    );
  }
}

/**
 * Register models from a static list. For use in tests and the CLI setup
 * wizard where the SDK subprocess is not available.
 */
export function registerClaudeModelsStatic(models: ModelInfo[]): void {
  registerProviderPrefix("claude-");
  registerModels(models);
}

/** Default model definitions for CLI setup wizard and tests. */
export const CLAUDE_MODELS_STATIC: ModelInfo[] = convertSdkModels([
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Sonnet 4.6 · Best for everyday tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "sonnet[1m]",
    displayName: "Sonnet (1M context)",
    description: "Sonnet 4.6 with 1M context · Large context window",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Opus 4.6 · Most capable for complex work",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  {
    value: "opus[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 4.6 with 1M context · Large context window",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
]);
