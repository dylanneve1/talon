/**
 * Anthropic model definitions for the Claude SDK backend.
 *
 * This is the single source of truth for Claude model metadata —
 * display names, aliases, capabilities, tiers, and fallback chains.
 */

import { registerModels } from "../../core/models.js";
import type { ModelInfo } from "../../core/models.js";

export const CLAUDE_MODELS: ModelInfo[] = [
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

/** Register all Claude models in the global registry. */
export function registerClaudeModels(): void {
  registerModels(CLAUDE_MODELS);
}
