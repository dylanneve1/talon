/**
 * Codex usage-exhausted detection: the `CodexUsageExhaustedError` surfaced
 * when the rollout JSONL positively indicates no remaining credits, plus the
 * `probeUsageExhausted` helper both recovery paths consult.
 */

import { classifyRateLimits, readLastRolloutSnapshot } from "../token-usage.js";

/**
 * Error class for usage-exhausted Codex failures. Thrown when the
 * rollout JSONL positively indicates the account has no remaining
 * credits — retrying on a fallback model would just hit the same wall,
 * so we surface the cause clearly instead of looping.
 */
export class CodexUsageExhaustedError extends Error {
  constructor(
    public readonly modelTried: string,
    public readonly authMode: "chatgpt" | "api-key" | "none" | undefined,
  ) {
    const authNote =
      authMode === "chatgpt"
        ? " (free ChatGPT OAuth — credit window resets periodically; or " +
          "set TALON_CODEX_KEY / codexApiKey for billing-based access)"
        : authMode === "api-key"
          ? " (api-key tier — check billing or rate-limit window)"
          : "";
    super(`Codex usage exhausted while running ${modelTried}${authNote}`);
    this.name = "CodexUsageExhaustedError";
  }
}

/**
 * Probe the rollout JSONL for a usage-exhausted signal.
 *
 * Returns the snapshot's classification (`"exhausted" | "healthy" |
 * "unknown"`) plus the raw rate-limits payload for log enrichment.
 * Never throws — file IO errors degrade to `"unknown"`.
 *
 * Pulled out so both the silent-exit path and the explicit-mismatch
 * path can consult it (an explicit mismatch on an exhausted account is
 * possible; we'd rather surface "usage exhausted" than swap models in
 * that case too).
 */
export async function probeUsageExhausted(
  threadId: string | undefined,
): Promise<
  | { classification: "exhausted"; limitId?: string; balance?: string }
  | { classification: "healthy" }
  | { classification: "unknown" }
> {
  if (!threadId) return { classification: "unknown" };
  let snap;
  try {
    snap = await readLastRolloutSnapshot(threadId);
  } catch {
    return { classification: "unknown" };
  }
  const rl = snap?.rateLimits;
  const cls = classifyRateLimits(rl);
  if (cls === "exhausted") {
    return {
      classification: "exhausted",
      limitId: rl?.limitId,
      balance: rl?.creditsBalance,
    };
  }
  return { classification: cls };
}
