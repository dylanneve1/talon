/**
 * Antigravity reasoning-effort vocabulary.
 *
 * agy expresses effort in two places at once, and the precedence
 * between them is the whole content of this module:
 *
 *   1. **Baked into the model id.** Most slugs carry the level as a
 *      suffix — `gemini-3.8-flash-high`, `gemini-3.1-pro-low`. Picking
 *      such an id IS picking an effort.
 *   2. **The `--effort low|medium|high` flag.** Accepted alongside any
 *      model.
 *
 * Precedence Talon applies: a requested level first tries to re-point
 * the model id at the sibling slug carrying that suffix (so the CLI
 * validates the combination for us and the picker keeps showing the
 * model actually in use); `--effort` is then passed as well, so a
 * suffix-less id (`claude-sonnet-4-6`, `gpt-oss-120b-medium` has a
 * baked medium but no siblings) still honours the request. Levels agy
 * cannot express (`off`, `minimal`, `xhigh`, `max`) fall through to
 * the model's own default with no flag and no id rewrite — the same
 * "let the model decide" behaviour codex's mapping produces.
 */

import type { ReasoningEffortLevel } from "../../core/types.js";

/** The three levels `--effort` accepts. */
export type AgyEffort = "low" | "medium" | "high";

const AGY_EFFORTS: readonly AgyEffort[] = ["low", "medium", "high"];

/** True for one of the three suffixes agy bakes into model ids. */
function isAgyEffort(value: string): value is AgyEffort {
  return (AGY_EFFORTS as readonly string[]).includes(value);
}

/**
 * Map a canonical level onto `--effort`, or undefined when agy has no
 * way to express it (`off` / `minimal` / `xhigh` / `max`, or nothing
 * requested).
 */
export function toAgyEffort(
  level: ReasoningEffortLevel | undefined,
): AgyEffort | undefined {
  if (!level) return undefined;
  return isAgyEffort(level) ? level : undefined;
}

/** The effort suffix baked into a model id, if it has one. */
export function effortSuffixOf(modelId: string): AgyEffort | undefined {
  const tail = modelId.slice(modelId.lastIndexOf("-") + 1);
  return isAgyEffort(tail) ? tail : undefined;
}

/** The model id with any effort suffix stripped. */
export function modelIdStem(modelId: string): string {
  const suffix = effortSuffixOf(modelId);
  return suffix ? modelId.slice(0, -(suffix.length + 1)) : modelId;
}

/**
 * Re-point a model id at the sibling slug carrying `effort`, when such
 * a sibling exists in `catalogIds`. Returns the original id when the
 * model has no effort suffix, when the sibling isn't offered, or when
 * no effort was requested — never invents an id the CLI would reject
 * (headless agy exits non-zero on an unknown `--model`).
 */
export function applyEffortToModelId(
  modelId: string,
  effort: AgyEffort | undefined,
  catalogIds: readonly string[],
): string {
  if (!effort) return modelId;
  if (!effortSuffixOf(modelId)) return modelId;
  const candidate = `${modelIdStem(modelId)}-${effort}`;
  return catalogIds.includes(candidate) ? candidate : modelId;
}
