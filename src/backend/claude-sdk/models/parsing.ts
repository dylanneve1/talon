/**
 * Claude model identity parsing — extract family/version/1M-context from SDK
 * model metadata, derive display names, and generate resolution aliases.
 *
 * Pure functions + the SDK model types. No SDK calls, no registry writes.
 */

export type SdkModelInfo = {
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

export type ParsedModelIdentity = {
  family: string | null;
  version: string | null;
  claudeId: string | null;
  isOneMillion: boolean;
};

export type SdkModelRecord = SdkModelInfo & {
  index: number;
  identity: ParsedModelIdentity;
  familyKey: string | null;
  variantKey: string | null;
};

export type AliasFormOptions = {
  /** Emit bare, unsuffixed forms ("fable", "fable-5", "claude-fable-5"). */
  includeBare: boolean;
  /** Emit `[1m]`-suffixed forms ("fable[1m]", "claude-fable-5[1m]"). */
  include1m: boolean;
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
 * can list both.
 */
export function deriveDisplayName(
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
 */
function detectOneMillion(model: SdkModelInfo): boolean {
  if (model.value.endsWith("[1m]")) return true;
  const text =
    `${model.description ?? ""} ${model.displayName ?? ""}`.toLowerCase();
  return /\b1m\b/.test(text) && text.includes("context");
}

export function describeSdkModel(model: SdkModelInfo): ParsedModelIdentity {
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

export function buildFamilyKey(identity: ParsedModelIdentity): string | null {
  return identity.family
    ? `${identity.family}:${identity.version ?? "*"}`
    : null;
}

/**
 * Variant key groups only *true* duplicates — same family, version, AND
 * context size. Base and 1M variants of one family+version land in separate
 * buckets so both surface in the picker, while redundant longhand ids collapse.
 */
export function buildVariantKey(identity: ParsedModelIdentity): string | null {
  const familyKey = buildFamilyKey(identity);
  if (!familyKey) return null;
  return `${familyKey}:${identity.isOneMillion ? "1m" : "base"}`;
}

/**
 * Generate resolution aliases for a model's identity.
 *
 *  - A base entry owns the bare forms ("sonnet", "sonnet-4-6", …).
 *  - A 1M entry owns the `[1m]` forms; it additionally claims the bare forms
 *    only when no base sibling exists (e.g. Fable, shipped solely as
 *    `claude-fable-5[1m]`, must still resolve from "fable").
 */
export function buildGeneratedAliases(
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
 * duplicates*:
 *   0 — "default"                      (SDK-recommended canonical)
 *   1 — short non-claude-prefixed      (e.g. sonnet, sonnet[1m])
 *   2 — claude-prefixed (legacy)       (e.g. claude-sonnet-4-6[1m])
 */
export function getPreferredModelPriority(record: SdkModelRecord): number {
  if (record.value === "default") return 0;
  return record.value.startsWith("claude-") ? 2 : 1;
}

export function buildSdkModelRecords(
  sdkModels: SdkModelInfo[],
): SdkModelRecord[] {
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

export function mergeAliases(...lists: readonly string[][]): string[] {
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
