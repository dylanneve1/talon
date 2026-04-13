/**
 * Claude model discovery — queries the SDK for available models.
 *
 * On init, registers a static fallback set immediately (so the registry
 * is never empty), then spawns a background SDK query to discover the
 * actual model list and upgrades the registry with live data.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { registerModels } from "../../core/models.js";
import type { ModelInfo } from "../../core/models.js";
import { log, logWarn } from "../../util/log.js";

// ── Static fallback models ──────────────────────────────────────────────────

/**
 * Minimal static set registered synchronously so the registry is usable
 * before the async SDK discovery completes. These are overwritten once
 * live data arrives.
 */
const FALLBACK_MODELS: ModelInfo[] = [
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

// ── Tier / fallback inference ───────────────────────────────────────────────

/** Infer tier from model ID — used when the SDK doesn't provide it. */
function inferTier(modelId: string): ModelInfo["tier"] {
  if (modelId.includes("opus")) return "premium";
  if (modelId.includes("haiku")) return "economy";
  return "balanced";
}

/** Build short aliases from a model ID like "claude-sonnet-4-6". */
function buildAliases(modelId: string): string[] {
  const aliases: string[] = [];
  // Extract family name (opus, sonnet, haiku, etc.)
  const match = modelId.match(/claude-(\w+)-(.+)/);
  if (match) {
    const family = match[1]; // "sonnet"
    const version = match[2]; // "4-6"
    aliases.push(family); // "sonnet"
    aliases.push(`${family}-${version}`); // "sonnet-4-6"
    aliases.push(`${family}-${version.replace(/-/g, ".")}`); // "sonnet-4.6"
  }
  return aliases;
}

// ── SDK model discovery ─────────────────────────────────────────────────────

/**
 * Convert SDK ModelInfo to our registry ModelInfo format.
 * Sorts models by tier and sets up fallback chains automatically.
 */
function convertSdkModels(
  sdkModels: Array<{
    value: string;
    displayName: string;
    description: string;
  }>,
): ModelInfo[] {
  // Build registry entries from SDK data
  const models: ModelInfo[] = sdkModels.map((m) => ({
    id: m.value,
    displayName: m.displayName,
    description: m.description,
    aliases: buildAliases(m.value),
    provider: "anthropic",
    capabilities: {
      // Haiku models don't support 1M context
      supports1mContext: !m.value.includes("haiku"),
    },
    tier: inferTier(m.value),
  }));

  // Sort by tier: premium first, then balanced, then economy
  const tierOrder = { premium: 0, balanced: 1, economy: 2 };
  models.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  // Set up fallback chain: each model falls back to the next tier down
  for (let i = 0; i < models.length - 1; i++) {
    if (!models[i].fallback) {
      models[i].fallback = models[i + 1].id;
    }
  }

  return models;
}

/**
 * Discover models from the SDK by spawning a throwaway query and calling
 * supportedModels(). Fire-and-forget — non-blocking, non-fatal.
 */
async function discoverModelsFromSdk(
  sdkOptions: Record<string, unknown>,
): Promise<void> {
  const abort = new AbortController();
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

    // Drain stream in background to prevent backpressure
    const drainPromise = (async () => {
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
        () => reject(new Error("model discovery timed out")),
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

    if (sdkModels.length > 0) {
      const models = convertSdkModels(sdkModels);
      registerModels(models);
      log(
        "agent",
        `Discovered ${models.length} models from SDK: ${models.map((m) => m.id).join(", ")}`,
      );
    }

    abort.abort();
    await drainPromise;
  } catch (err) {
    abort.abort();
    logWarn(
      "agent",
      `Model discovery failed (using static fallback): ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Register static fallback models immediately, then kick off async
 * SDK discovery to upgrade with live data.
 */
export function registerClaudeModels(
  sdkOptions?: Record<string, unknown>,
): void {
  // Register static models synchronously — always available
  registerModels(FALLBACK_MODELS);

  // If SDK options are provided, discover live models in the background
  if (sdkOptions) {
    discoverModelsFromSdk(sdkOptions).catch(() => {});
  }
}
