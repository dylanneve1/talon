/**
 * Claude model discovery — queries the SDK for available models.
 *
 * Spawns a throwaway SDK subprocess, calls supportedModels(), and
 * registers the results in the global model registry. This is the
 * only source of truth for available Claude models — if the SDK
 * fails to provide models, initialization is aborted.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { registerModels, clearModelsByProvider } from "../../core/models.js";
import type { ModelInfo } from "../../core/models.js";
import { log, logError } from "../../util/log.js";

type SdkModelInfo = {
  value: string;
  displayName: string;
  description: string;
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
    isOneMillion: model.value.endsWith("[1m]"),
  };
}

function buildFamilyKey(identity: ParsedModelIdentity): string | null {
  return identity.family
    ? `${identity.family}:${identity.version ?? "*"}`
    : null;
}

function buildVariantKey(identity: ParsedModelIdentity): string | null {
  const familyKey = buildFamilyKey(identity);
  return familyKey
    ? `${familyKey}:${identity.isOneMillion ? "1m" : "base"}`
    : null;
}

function appendOneMillionSuffix(alias: string, isOneMillion: boolean): string {
  return isOneMillion ? `${alias}[1m]` : alias;
}

function buildGeneratedAliases(identity: ParsedModelIdentity): string[] {
  if (!identity.family) return [];

  const aliases = [
    appendOneMillionSuffix(identity.family, identity.isOneMillion),
  ];

  if (identity.version) {
    aliases.push(
      appendOneMillionSuffix(
        `${identity.family}-${identity.version}`,
        identity.isOneMillion,
      ),
      appendOneMillionSuffix(
        `${identity.family}-${toDashVersion(identity.version)}`,
        identity.isOneMillion,
      ),
    );
  }

  if (identity.claudeId) {
    aliases.push(
      appendOneMillionSuffix(identity.claudeId, identity.isOneMillion),
    );
  }

  return aliases;
}

function getPreferredModelPriority(value: string): number {
  if (value === "default") return 0;
  if (!value.startsWith("claude-")) return 1;
  return 2;
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

function buildPreferredCanonicalIds(
  records: readonly SdkModelRecord[],
): Map<string, string> {
  const grouped = new Map<string, SdkModelRecord[]>();

  for (const record of records) {
    if (!record.variantKey) continue;
    const variants = grouped.get(record.variantKey) ?? [];
    variants.push(record);
    grouped.set(record.variantKey, variants);
  }

  const preferred = new Map<string, string>();
  for (const [variantKey, variants] of grouped) {
    const canonical = [...variants].sort((left, right) => {
      const priorityDelta =
        getPreferredModelPriority(left.value) -
        getPreferredModelPriority(right.value);
      if (priorityDelta !== 0) return priorityDelta;
      return left.index - right.index;
    })[0];
    if (canonical) preferred.set(variantKey, canonical.value);
  }

  return preferred;
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

function buildHiddenModelAliases(
  records: readonly SdkModelRecord[],
  preferredCanonicalIds: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const hiddenAliases = new Map<string, string[]>();

  for (const record of records) {
    if (!record.variantKey) continue;
    const preferredId = preferredCanonicalIds.get(record.variantKey);
    if (!preferredId || preferredId === record.value) continue;

    hiddenAliases.set(
      preferredId,
      mergeAliases(
        hiddenAliases.get(preferredId) ?? [],
        [record.value],
        buildGeneratedAliases(record.identity),
      ),
    );
  }

  return hiddenAliases;
}

// ── SDK → registry conversion ───────────────────────────────────────────────

/**
 * Convert SDK ModelInfo to our registry format.
 * Keeps SDK model IDs/display names intact while deriving compatibility aliases
 * and duplicate collapsing from the SDK metadata instead of hardcoded versions.
 */
function convertSdkModels(sdkModels: SdkModelInfo[]): ModelInfo[] {
  const records = buildSdkModelRecords(sdkModels);
  const preferredCanonicalIds = buildPreferredCanonicalIds(records);
  const hiddenModelAliases = buildHiddenModelAliases(
    records,
    preferredCanonicalIds,
  );
  const hiddenModels = new Set(
    records
      .filter(
        (record) =>
          !!record.variantKey &&
          preferredCanonicalIds.get(record.variantKey) !== undefined &&
          preferredCanonicalIds.get(record.variantKey) !== record.value,
      )
      .map((record) => record.value),
  );

  const usedKeys = new Set<string>();
  const models: ModelInfo[] = [];

  for (const record of records) {
    if (hiddenModels.has(record.value)) continue;

    const canonicalKey = record.value.toLowerCase();
    if (usedKeys.has(canonicalKey)) continue;

    const aliases = mergeAliases(
      buildGeneratedAliases(record.identity),
      hiddenModelAliases.get(record.value) ?? [],
    )
      .filter((alias) => alias.toLowerCase() !== canonicalKey)
      .filter((alias) => !usedKeys.has(alias.toLowerCase()));

    usedKeys.add(canonicalKey);
    for (const alias of aliases) {
      usedKeys.add(alias.toLowerCase());
    }

    models.push({
      id: record.value,
      displayName: record.displayName,
      description: record.description,
      aliases,
      provider: "anthropic",
    });
  }

  return models;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Discover available models from the Claude Agent SDK and register them.
 *
 * Spawns a throwaway SDK subprocess, calls supportedModels(), converts the
 * results to our registry format, and registers them. Throws on failure —
 * if the SDK can't provide models, Talon cannot function.
 */
export async function registerClaudeModels(sdkOptions: {
  model: string;
  cwd?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
}): Promise<void> {
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
        ...sdkOptions,
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
        () => reject(new Error("model discovery timed out after 15s")),
        15_000,
      );
    });

    let sdkModels: SdkModelInfo[];
    try {
      sdkModels = await Promise.race([q.supportedModels(), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    if (sdkModels.length === 0) {
      throw new Error("SDK returned empty model list");
    }

    const models = convertSdkModels(sdkModels);
    clearModelsByProvider("anthropic");
    registerModels(models);
    log(
      "agent",
      `Discovered ${models.length} models from SDK: ${models.map((m) => m.id).join(", ")}`,
    );

    abort.abort();
    await drainPromise;
  } catch (err) {
    abort.abort();
    if (drainPromise) await drainPromise.catch(() => {});
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
  registerModels(models);
}

/** Default model definitions for CLI setup wizard and tests. */
export const CLAUDE_MODELS_STATIC: ModelInfo[] = convertSdkModels([
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Sonnet · Best for everyday tasks",
  },
  {
    value: "sonnet[1m]",
    displayName: "Sonnet (1M context)",
    description: "Sonnet with 1M context · Large context window",
  },
  {
    value: "opus",
    displayName: "Opus",
    description: "Opus · Most capable for complex work",
  },
  {
    value: "opus[1m]",
    displayName: "Opus (1M context)",
    description: "Opus with 1M context · Large context window",
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku · Fastest for quick answers",
  },
]);

