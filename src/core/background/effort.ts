/**
 * Reasoning-effort resolution for background runs (heartbeat, dream).
 *
 * Both background agents take an effort level from config
 * (`heartbeatEffort` / `dreamEffort`). Two separate questions hide behind
 * "apply that level", and they belong to different layers:
 *
 *   1. *Is the level available on this model?* — a model-capability
 *      question. Every backend catalog already answers it through the
 *      `models.getRawModelInfo` capability (`supportedReasoningLevels`),
 *      which is the same channel the frontends' effort pickers read. So it
 *      is answered here, once, against the `Backend` abstraction.
 *
 *   2. *How is the level expressed to the provider?* — Claude thinking
 *      options, Codex `modelReasoningEffort`, nothing at all for
 *      Kilo/OpenCode. That is adapter work and stays inside each backend's
 *      one-shot runner.
 *
 * Keeping (1) here is what stops four one-shot runners from each growing
 * their own copy of the same catalog lookup.
 */

import type { Backend } from "../agent-runtime/capabilities.js";
import type { ReasoningEffortLevel } from "../types.js";
import {
  normalizeReasoningLevels,
  supportsReasoningLevel,
} from "../models/reasoning-levels.js";

export type BackgroundEffortResolution = {
  /** The level to pass to the backend, or undefined to use its default. */
  effort?: ReasoningEffortLevel;
  /**
   * Set when a configured level was discarded — a log-ready explanation of
   * what was asked for and why the run proceeds without it. A dropped level
   * never fails the run: a stale effort setting shouldn't cost an operator
   * their hourly heartbeat.
   */
  dropped?: string;
};

/**
 * Resolve the effort level a background run should ask for.
 *
 * Unset config → `{}` (backend/model default, i.e. what background runs did
 * before the knob existed). A backend with no catalog capability, an
 * unreachable catalog, or a model that reports no level metadata all pass
 * the level through untouched: absent metadata is not evidence that the
 * level is unsupported, and the adapter still has the final say.
 */
export async function resolveBackgroundEffort(params: {
  requested: ReasoningEffortLevel | undefined;
  model: string;
  backend: Backend | null;
}): Promise<BackgroundEffortResolution> {
  const { requested, model, backend } = params;
  if (!requested) return {};

  const catalog = backend?.models;
  if (!catalog) return { effort: requested };

  let info;
  try {
    info = await catalog.getRawModelInfo(model);
  } catch {
    return { effort: requested }; // catalog unavailable — don't second-guess
  }

  const levels = normalizeReasoningLevels(info?.supportedReasoningLevels);
  if (levels.length === 0) return { effort: requested };

  if (!supportsReasoningLevel(requested, levels)) {
    return {
      dropped:
        `configured effort "${requested}" is not available on "${model}" ` +
        `(supports: ${levels.join(", ")}) — running the model default`,
    };
  }
  return { effort: requested };
}
