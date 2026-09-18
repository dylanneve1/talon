import type {
  ReasoningEffortLevel,
  UnifiedModelInfo,
} from "../../core/types.js";
import type { Backend } from "../../core/agent-runtime/capabilities.js";
import { resolveActiveModelForChat } from "../../core/models/active-model.js";
import type { TalonConfig } from "../../core/config/index.js";
import {
  normalizeReasoningLevels,
  supportsReasoningLevel,
  REASONING_LEVEL_DESCRIPTIONS,
} from "../../core/models/reasoning-levels.js";
export { supportsReasoningLevel };

/**
 * Effort-level descriptions shown next to each option in a picker.
 *
 * One home for both frontends: Discord renders them as select-menu
 * descriptions, and anything else offering the same choice reads the
 * same table rather than copying it.
 */
export const EFFORT_DESCRIPTIONS: Record<string, string> = {
  ...REASONING_LEVEL_DESCRIPTIONS,
};

export type ActiveReasoningLevels = {
  activeModel: string | null;
  modelInfo?: UnifiedModelInfo;
  levels: ReasoningEffortLevel[];
};

export function displayReasoningEffort(
  effort: string | undefined,
  levels: readonly ReasoningEffortLevel[],
): string {
  if (!effort || effort === "adaptive") return "adaptive";
  return supportsReasoningLevel(effort, levels) ? effort : "adaptive";
}

export async function getActiveReasoningLevels(params: {
  chatId: string;
  backend: Backend | null;
  backendId: string | null;
  config: TalonConfig;
}): Promise<ActiveReasoningLevels> {
  const { model: activeModel } = await resolveActiveModelForChat(
    params.chatId,
    params.backend,
    params.backendId,
    params.config,
  );
  if (!activeModel) return { activeModel: null, levels: [] };

  const modelInfo =
    await params.backend?.models?.getRawModelInfo?.(activeModel);
  const levels = normalizeReasoningLevels(modelInfo?.supportedReasoningLevels);
  return { activeModel, modelInfo, levels };
}
