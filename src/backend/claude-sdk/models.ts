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

// ── Tier / fallback inference ───────────────────────────────────────────────

/** Infer tier from the SDK model metadata. */
function inferTier(model: SdkModelInfo): ModelInfo["tier"] {
  const searchableText =
    `${model.value} ${model.displayName} ${model.description}`.toLowerCase();
  if (searchableText.includes("opus")) return "premium";
  if (searchableText.includes("haiku")) return "economy";
  return "balanced";
}

// ── SDK → registry conversion ───────────────────────────────────────────────

/**
 * Compatibility aliases we preserve for Talon's existing config values.
 *
 * The SDK now returns short IDs like "default", "opus", and "sonnet[1m]".
 * We keep the SDK IDs as canonical, and only add explicit aliases for older
 * Talon config values and shortcuts that users may already have stored.
 */
const COMPATIBILITY_ALIASES: Record<string, string[]> = {
  default: ["sonnet", "sonnet-4-6", "sonnet-4.6", "claude-sonnet-4-6"],
  "sonnet[1m]": [
    "sonnet-4-6[1m]",
    "sonnet-4.6[1m]",
    "claude-sonnet-4-6[1m]",
  ],
  opus: ["claude-opus-4-6", "opus-4-6", "opus-4.6"],
  "opus[1m]": ["claude-opus-4-6[1m]", "opus-4-6[1m]", "opus-4.6[1m]"],
  haiku: ["claude-haiku-4-5", "haiku-4-5", "haiku-4.5"],
};

/**
 * Hidden SDK duplicates we collapse into the user-facing entry that Claude Code
 * recommends for that model family.
 */
const HIDDEN_DUPLICATE_MODELS: Record<string, string> = {
  "claude-sonnet-4-6": "default",
};

function buildCompatibilityAliases(modelId: string): string[] {
  return COMPATIBILITY_ALIASES[modelId] ?? [];
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
  values: ReadonlySet<string>,
): Map<string, string[]> {
  const hiddenAliases = new Map<string, string[]>();

  for (const [hiddenValue, targetValue] of Object.entries(
    HIDDEN_DUPLICATE_MODELS,
  )) {
    if (!values.has(hiddenValue) || !values.has(targetValue)) continue;
    hiddenAliases.set(
      targetValue,
      mergeAliases(
        hiddenAliases.get(targetValue) ?? [],
        [hiddenValue],
        buildCompatibilityAliases(hiddenValue),
      ),
    );
  }

  return hiddenAliases;
}

function buildOneMillionContextVariants(
  values: ReadonlySet<string>,
): Map<string, string> {
  const variants = new Map<string, string>();

  for (const value of values) {
    if (!value.endsWith("[1m]")) continue;
    variants.set(value.slice(0, -4), value);
  }

  const sonnetVariant = variants.get("sonnet");
  if (sonnetVariant) {
    variants.set("default", sonnetVariant);
    variants.set("claude-sonnet-4-6", sonnetVariant);
  }

  return variants;
}

/**
 * Convert SDK ModelInfo to our registry format.
 * Keeps SDK model IDs/display names intact while adding a thin compatibility
 * layer for older Talon config values.
 */
function convertSdkModels(sdkModels: SdkModelInfo[]): ModelInfo[] {
  const values = new Set(sdkModels.map((model) => model.value));
  const hiddenModelAliases = buildHiddenModelAliases(values);
  const oneMillionContextVariants = buildOneMillionContextVariants(values);
  const hiddenModels = new Set(
    Object.entries(HIDDEN_DUPLICATE_MODELS)
      .filter(([hiddenValue, targetValue]) =>
        values.has(hiddenValue) && values.has(targetValue),
      )
      .map(([hiddenValue]) => hiddenValue),
  );

  const usedKeys = new Set<string>();
  const models: ModelInfo[] = [];

  for (const model of sdkModels) {
    if (hiddenModels.has(model.value)) continue;

    const canonicalKey = model.value.toLowerCase();
    if (usedKeys.has(canonicalKey)) continue;

    const aliases = mergeAliases(
      buildCompatibilityAliases(model.value),
      hiddenModelAliases.get(model.value) ?? [],
    )
      .filter((alias) => alias.toLowerCase() !== canonicalKey)
      .filter((alias) => !usedKeys.has(alias.toLowerCase()));

    usedKeys.add(canonicalKey);
    for (const alias of aliases) {
      usedKeys.add(alias.toLowerCase());
    }

    const oneMillionContextModelId = model.value.endsWith("[1m]")
      ? undefined
      : oneMillionContextVariants.get(model.value);

    models.push({
      id: model.value,
      displayName: model.displayName,
      description: model.description,
      aliases,
      provider: "anthropic",
      capabilities: {
        supports1mContext:
          model.value.endsWith("[1m]") || oneMillionContextModelId !== undefined,
        ...(oneMillionContextModelId !== undefined
          ? { oneMillionContextModelId }
          : {}),
      },
      tier: inferTier(model),
    });
  }

  const tierOrder = { premium: 0, balanced: 1, economy: 2 };
  models.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  // Fallback chain: each model falls back to the first model in the next lower tier
  for (const model of models) {
    if (model.fallback) continue;
    const nextTier = models.find(
      (m) => tierOrder[m.tier] > tierOrder[model.tier],
    );
    if (nextTier) model.fallback = nextTier.id;
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
export const CLAUDE_MODELS_STATIC: ModelInfo[] = [
  {
    id: "opus",
    displayName: "Opus",
    description: "Opus 4.6 · Most capable for complex work",
    aliases: ["claude-opus-4-6", "opus-4.6", "opus-4-6"],
    provider: "anthropic",
    capabilities: {
      supports1mContext: true,
      oneMillionContextModelId: "opus[1m]",
    },
    tier: "premium",
    fallback: "default",
  },
  {
    id: "default",
    displayName: "Default (recommended)",
    description: "Sonnet 4.6 · Best for everyday tasks",
    aliases: ["sonnet", "sonnet-4.6", "sonnet-4-6", "claude-sonnet-4-6"],
    provider: "anthropic",
    capabilities: {
      supports1mContext: true,
      oneMillionContextModelId: "sonnet[1m]",
    },
    tier: "balanced",
    fallback: "haiku",
  },
  {
    id: "opus[1m]",
    displayName: "Opus (1M context)",
    description:
      "Opus 4.6 with 1M context · Billed as extra usage · $5/$25 per Mtok",
    aliases: ["claude-opus-4-6[1m]", "opus-4.6[1m]", "opus-4-6[1m]"],
    provider: "anthropic",
    capabilities: { supports1mContext: true },
    tier: "premium",
    fallback: "default",
  },
  {
    id: "sonnet[1m]",
    displayName: "Sonnet (1M context)",
    description:
      "Sonnet 4.6 with 1M context · Billed as extra usage · $3/$15 per Mtok",
    aliases: [
      "claude-sonnet-4-6[1m]",
      "sonnet-4.6[1m]",
      "sonnet-4-6[1m]",
    ],
    provider: "anthropic",
    capabilities: { supports1mContext: true },
    tier: "balanced",
    fallback: "haiku",
  },
  {
    id: "haiku",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
    aliases: ["claude-haiku-4-5", "haiku-4.5", "haiku-4-5"],
    provider: "anthropic",
    capabilities: { supports1mContext: false },
    tier: "economy",
  },
];
