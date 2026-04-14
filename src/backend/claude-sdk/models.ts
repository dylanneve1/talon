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

// ── Tier / fallback inference ───────────────────────────────────────────────

/** Infer tier from model ID. */
function inferTier(modelId: string): ModelInfo["tier"] {
  if (modelId.includes("opus")) return "premium";
  if (modelId.includes("haiku")) return "economy";
  return "balanced";
}

/** Build short aliases from a model ID like "claude-sonnet-4-6". */
function buildAliases(modelId: string): string[] {
  const aliases: string[] = [];
  const match = modelId.match(/claude-(\w+)-(.+)/);
  if (match) {
    const family = match[1];
    const version = match[2];
    aliases.push(family);
    aliases.push(`${family}-${version}`);
    aliases.push(`${family}-${version.replace(/-/g, ".")}`);
  }
  return aliases;
}

// ── SDK → registry conversion ───────────────────────────────────────────────

/**
 * Derive canonical claude-{family}-{major}-{minor} ID from a short alias entry.
 * Returns undefined if the description doesn't contain a parseable version.
 */
function deriveCanonicalId(
  value: string,
  description: string,
): string | undefined {
  // Already canonical — nothing to do
  if (value.startsWith("claude-")) return value;
  // Parse "Sonnet 4.6 · …" or "Haiku 4.5 · …" from description
  const match = description.match(/([A-Za-z]+)\s+(\d+)\.(\d+)/);
  if (!match) return undefined;
  return `claude-${match[1].toLowerCase()}-${match[2]}-${match[3]}`;
}

/**
 * Convert SDK ModelInfo to our registry format.
 * Sorts by tier and builds fallback chains automatically.
 */
function convertSdkModels(
  sdkModels: Array<{
    value: string;
    displayName: string;
    description: string;
  }>,
): ModelInfo[] {
  // Filter out SDK artifacts:
  // - [1m] variants: we add this suffix ourselves in options.ts
  // The SDK (≥0.2.104) returns short aliases ("sonnet", "haiku") instead of
  // canonical IDs. Notably Sonnet only appears as "default" and "sonnet[1m]" —
  // the "default" entry IS the Sonnet model, so we keep it and derive the real
  // canonical ID from its description rather than discarding it.
  const filtered = sdkModels.filter((m) => !m.value.includes("["));

  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const m of filtered) {
    const id = deriveCanonicalId(m.value, m.description) ?? m.value;
    // Skip entries where we couldn't derive a canonical ID from "default"
    if (id === "default") continue;
    // Deduplicate — the SDK may return both "opus" and "claude-opus-4-6"
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      displayName: m.displayName,
      description: m.description,
      aliases: buildAliases(id),
      provider: "anthropic",
      capabilities: {
        supports1mContext: !id.includes("haiku"),
      },
      tier: inferTier(id),
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

    let sdkModels: Array<{
      value: string;
      displayName: string;
      description: string;
    }>;
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
    id: "claude-opus-4-6",
    displayName: "Opus 4.6",
    description: "smartest",
    aliases: ["opus", "opus-4.6", "opus-4-6"],
    provider: "anthropic",
    capabilities: { supports1mContext: true },
    tier: "premium",
    fallback: "claude-sonnet-4-6",
  },
  {
    id: "claude-sonnet-4-6",
    displayName: "Sonnet 4.6",
    description: "fast, balanced",
    aliases: ["sonnet", "sonnet-4.6", "sonnet-4-6"],
    provider: "anthropic",
    capabilities: { supports1mContext: true },
    tier: "balanced",
    fallback: "claude-haiku-4-5",
  },
  {
    id: "claude-haiku-4-5",
    displayName: "Haiku 4.5",
    description: "fastest, cheapest",
    aliases: ["haiku", "haiku-4.5", "haiku-4-5"],
    provider: "anthropic",
    capabilities: { supports1mContext: false },
    tier: "economy",
  },
];
