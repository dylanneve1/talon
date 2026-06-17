/**
 * Static fallback model list — used by the CLI setup wizard and tests where
 * the SDK subprocess isn't available. Run through `convertSdkModels` so the
 * static entries get the same alias/fallback derivation as discovered ones.
 */

import type { ModelInfo } from "../../../core/models/catalog.js";
import { convertSdkModels } from "./convert.js";

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
