/**
 * SDK → registry conversion. Groups SDK models into variant buckets, picks a
 * canonical per bucket, derives display names + aliases + the fallback chain,
 * and emits the registry `ModelInfo[]`.
 */

import type { ModelInfo } from "../../../core/models/catalog.js";
import { normalizeReasoningLevels } from "../../../core/models/reasoning-levels.js";
import {
  buildSdkModelRecords,
  buildGeneratedAliases,
  deriveDisplayName,
  getPreferredModelPriority,
  mergeAliases,
  type AliasFormOptions,
  type SdkModelInfo,
  type SdkModelRecord,
} from "./parsing.js";

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
 * same model exposed under multiple ids — collapse into one canonical entry
 * that absorbs the others' aliases. Display names, aliases, and the fallback
 * chain are all derived from SDK metadata, never hardcoded versions.
 */
export function convertSdkModels(sdkModels: SdkModelInfo[]): ModelInfo[] {
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
