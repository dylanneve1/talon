import type {
  ReasoningEffortLevel,
  UnifiedModelInfo,
} from "../../core/types.js";
import type { Backend } from "../../core/agent-runtime/capabilities.js";
import { resolveActiveModelForChat } from "../../core/models/active-model.js";
import type { TalonConfig } from "../../util/config.js";
import {
  normalizeReasoningLevels,
  supportsReasoningLevel,
} from "../../core/models/reasoning-levels.js";
export { supportsReasoningLevel };

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
