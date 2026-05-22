import type {
  QueryBackend,
  ReasoningEffortLevel,
  UnifiedModelInfo,
} from "../core/types.js";
import { resolveActiveModelForChat } from "../core/active-model.js";
import type { TalonConfig } from "../util/config.js";
import {
  normalizeReasoningLevels,
  REASONING_LEVEL_DESCRIPTIONS,
  REASONING_LEVEL_LABELS,
  supportsReasoningLevel,
} from "../core/reasoning-levels.js";
export {
  REASONING_LEVEL_DESCRIPTIONS,
  REASONING_LEVEL_LABELS,
  supportsReasoningLevel,
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
  backend: QueryBackend | null;
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

  const modelInfo = await params.backend?.getModelInfo?.(activeModel);
  const levels = normalizeReasoningLevels(modelInfo?.supportedReasoningLevels);
  return { activeModel, modelInfo, levels };
}
