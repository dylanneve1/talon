/**
 * Turn-time model-drift detection.
 *
 * The SDK result's `modelUsage` is keyed by the model that ACTUALLY
 * served the turn. Nothing compared it to the model we asked for — so
 * when the API substitutes (requested model withdrawn from the
 * catalog, rate-limit downshift, silent server-side fallback), the
 * only evidence was an INFO accounting line nobody reads. This module
 * turns that into a WARN with the fix in it, once per
 * (requested → actual) pair per process.
 */

import { logWarn } from "../../util/log.js";

/**
 * Alias-tolerant model identity: "opus" is the same model as
 * "claude-opus-4-8", "sonnet[1m]" the same as "sonnet". Substring
 * containment after normalisation is deliberately loose — a false
 * "same" (missed warning) is better than crying wolf on every alias
 * expansion.
 */
export function isSameModel(requested: string, actual: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\[1m\]/g, "")
      .trim();
  const r = norm(requested);
  const a = norm(actual);
  if (!r || !a) return true; // nothing to compare — don't warn
  return a === r || a.includes(r) || r.includes(a);
}

/** (requested→actual) pairs already warned about this process. */
const warned = new Set<string>();

/** Test seam. */
export function resetModelDriftWarnings(): void {
  warned.clear();
}

/**
 * Compare the requested model against the models that actually served
 * the turn (the `modelUsage` keys). Warns once per distinct pair.
 * "default" requests are skipped — no pin, nothing to drift from.
 */
export function checkModelDrift(
  requested: string,
  actualModels: readonly string[],
): void {
  if (!requested || requested === "default") return;
  if (actualModels.length === 0) return;
  if (actualModels.some((actual) => isSameModel(requested, actual))) return;

  const actual = actualModels.join(", ");
  const key = `${requested}→${actual}`;
  if (warned.has(key)) return;
  warned.add(key);
  logWarn(
    "agent",
    `[MODEL DRIFT] requested "${requested}" but the API served "${actual}" — ` +
      `the pinned model may no longer exist or was substituted upstream. ` +
      `Check "model" in config.json (or this chat's /model override).`,
  );
}
