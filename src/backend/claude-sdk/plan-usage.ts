/**
 * Claude.ai subscription rate-limit windows for /status.
 *
 * The 5-hour, weekly, and per-model utilisation percentages come from the
 * same OAuth endpoint Claude Code's own usage panel reads. The Agent SDK
 * also exposes them through a control request, but that path additionally
 * builds a local-session behaviour report and costs seconds per call; the
 * endpoint alone answers in well under a second.
 *
 * Everything degrades to `undefined`: no credentials, an API-key session
 * (plan limits don't apply), or any transport failure. /status hides the
 * section rather than rendering zeroes.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logWarn } from "../../util/log.js";
import type {
  PlanUsage,
  PlanWindow,
} from "../../core/agent-runtime/capabilities.js";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

let cache: { value: PlanUsage; fetchedAt: number } | undefined;
let inFlight: Promise<PlanUsage | undefined> | undefined;

function credentialsPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return join(
    configDir && configDir.length > 0 ? configDir : join(homedir(), ".claude"),
    ".credentials.json",
  );
}

interface OAuthCredentials {
  accessToken?: string;
  subscriptionType?: string;
}

async function readCredentials(): Promise<OAuthCredentials | undefined> {
  try {
    const parsed = JSON.parse(await readFile(credentialsPath(), "utf8")) as {
      claudeAiOauth?: OAuthCredentials;
    };
    const oauth = parsed.claudeAiOauth;
    return oauth?.accessToken ? oauth : undefined;
  } catch {
    return undefined;
  }
}

interface RawLimit {
  kind?: string;
  percent?: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

/**
 * Short display label for one window, or undefined to skip the row.
 *
 * Only the three documented kinds are rendered. The response also carries
 * internal codenamed windows; skipping unknown kinds keeps those out of the
 * user-facing panel.
 */
function windowLabel(limit: RawLimit): string | undefined {
  if (limit.kind === "session") return "5h";
  if (limit.kind === "weekly_all") return "7d";
  if (limit.kind === "weekly_scoped") {
    const model = limit.scope?.model?.display_name?.trim();
    return model && model.length > 0 ? model : undefined;
  }
  return undefined;
}

export function parsePlanUsage(
  body: unknown,
  subscriptionType?: string,
): PlanUsage | undefined {
  const limits = (body as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(limits)) return undefined;

  const windows: PlanWindow[] = [];
  for (const limit of limits as RawLimit[]) {
    const label = windowLabel(limit);
    if (!label) continue;
    const raw = limit.percent;
    const percent =
      typeof raw === "number" && Number.isFinite(raw)
        ? Math.max(0, Math.min(100, Math.round(raw)))
        : 0;
    windows.push({
      label,
      percent,
      ...(typeof limit.resets_at === "string"
        ? { resetsAt: limit.resets_at }
        : {}),
    });
  }

  if (windows.length === 0) return undefined;
  return {
    ...(subscriptionType ? { plan: subscriptionType } : {}),
    windows,
    fetchedAt: Date.now(),
  };
}

async function load(): Promise<PlanUsage | undefined> {
  const creds = await readCredentials();
  if (!creds?.accessToken) return undefined;

  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logWarn("agent", `plan usage: endpoint returned ${res.status}`);
      return undefined;
    }
    return parsePlanUsage(await res.json(), creds.subscriptionType);
  } catch (err) {
    logWarn(
      "agent",
      `plan usage: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Plan windows for /status, cached for a minute so a burst of commands
 * makes one request. A failed refresh falls back to the last known values
 * — `fetchedAt` lets the caller age them.
 */
export async function getPlanUsage(): Promise<PlanUsage | undefined> {
  // An API-key session bills against the key, not the subscription, so the
  // stored OAuth credentials would describe limits that don't apply here.
  if (process.env.ANTHROPIC_API_KEY) return undefined;

  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;

  inFlight ??= load().finally(() => {
    inFlight = undefined;
  });
  const loaded = await inFlight;
  if (loaded) cache = { value: loaded, fetchedAt: loaded.fetchedAt };
  return loaded ?? cache?.value;
}

/**
 * Expire the cache after the SDK reports a rate-limit change, so the next
 * /status re-reads instead of showing figures from before the turn.
 */
export function invalidatePlanUsage(): void {
  if (cache) cache.fetchedAt = 0;
}

export function resetPlanUsageForTest(): void {
  cache = undefined;
  inFlight = undefined;
}
