/**
 * Model-option helpers shared across commands, callbacks, and the settings
 * panel. Generic formatters live in frontend/shared/format.ts and are
 * re-exported here so existing import sites keep working.
 */

import type { ModelInfo } from "../../../core/models/catalog.js";
import { getModels } from "../../../core/models/catalog.js";

export {
  DEFAULT_PULSE_INTERVAL_MS,
  parseInterval,
  formatDuration,
  formatTokenCount,
  formatBytes,
  formatUsd,
  formatModelLabel,
} from "../../shared/format.js";

/** Display name for a known ModelInfo. */
export function formatModelOptionLabel(model: ModelInfo): string {
  return model.displayName;
}

/** Compact display name for a known ModelInfo. */
export function formatCompactModelLabel(model: ModelInfo): string {
  return model.displayName;
}

export function getTelegramModelOptions(): ModelInfo[] {
  const options: ModelInfo[] = [];
  const seenKeys = new Set<string>();

  for (const model of getModels()) {
    const key = model.displayName.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    options.push(model);
  }

  return options;
}
