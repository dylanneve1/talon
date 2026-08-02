/**
 * ChatGPT subscription rate-limit windows for the Codex backend.
 *
 * The Codex CLI reads these from an endpoint on the ChatGPT backend and
 * caches the result in its session transcripts; `/status` renders that cache
 * rather than re-fetching. Talon queries the endpoint directly so `/usage`
 * reports the current state instead of whatever the last turn happened to
 * see, using the OAuth token `codex login` already stored.
 *
 * Degrades to `undefined` for API-key installs (no plan to report), a
 * missing or expired token, or any transport failure.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logWarn } from "../../util/log.js";
import type {
  PlanUsage,
  PlanWindow,
} from "../../core/agent-runtime/capabilities.js";

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000;

let cache: { value: PlanUsage; fetchedAt: number } | undefined;
let inFlight: Promise<PlanUsage | undefined> | undefined;

function authPath(): string {
  const home = process.env.CODEX_HOME?.trim();
  return home && home.length > 0
    ? join(home, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

interface CodexAuth {
  accessToken: string;
  accountId?: string;
}

async function readAuth(): Promise<CodexAuth | undefined> {
  try {
    const parsed = JSON.parse(await readFile(authPath(), "utf8")) as {
      auth_mode?: string;
      tokens?: { access_token?: string; account_id?: string };
    };
    const token = parsed.tokens?.access_token;
    if (!token) return undefined;
    return {
      accessToken: token,
      ...(parsed.tokens?.account_id
        ? { accountId: parsed.tokens.account_id }
        : {}),
    };
  } catch {
    return undefined;
  }
}

interface RawWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

/**
 * Window label from its length. The plan exposes a weekly window and,
 * historically, a shorter one; naming them by duration keeps the label
 * right whichever windows the account actually has.
 */
function windowLabel(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return "limit";
  const hours = Math.round(seconds / 3600);
  if (hours % 24 === 0 && hours >= 24) return `${hours / 24}d`;
  return `${hours}h`;
}

function toWindow(raw: RawWindow | null | undefined): PlanWindow | undefined {
  if (!raw || typeof raw.used_percent !== "number") return undefined;
  return {
    label: windowLabel(raw.limit_window_seconds),
    percent: Math.max(0, Math.min(100, Math.round(raw.used_percent))),
    // `reset_at` is unix seconds; the shared shape speaks ISO.
    ...(typeof raw.reset_at === "number" && raw.reset_at > 0
      ? { resetsAt: new Date(raw.reset_at * 1000).toISOString() }
      : {}),
  };
}

export function parseCodexUsage(body: unknown): PlanUsage | undefined {
  const data = body as {
    plan_type?: string;
    rate_limit?: {
      primary_window?: RawWindow | null;
      secondary_window?: RawWindow | null;
    };
  } | null;
  const limit = data?.rate_limit;
  if (!limit) return undefined;

  const windows = [
    toWindow(limit.primary_window),
    toWindow(limit.secondary_window),
  ].filter((w): w is PlanWindow => Boolean(w));
  if (windows.length === 0) return undefined;

  return {
    ...(data?.plan_type ? { plan: data.plan_type } : {}),
    windows,
    fetchedAt: Date.now(),
  };
}

async function load(): Promise<PlanUsage | undefined> {
  const auth = await readAuth();
  if (!auth) return undefined;

  try {
    const res = await fetch(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {}),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      logWarn("agent", `codex usage: endpoint returned ${res.status}`);
      return undefined;
    }
    return parseCodexUsage(await res.json());
  } catch (err) {
    logWarn(
      "agent",
      `codex usage: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Plan windows for `/usage`, cached for a minute. A failed refresh keeps
 * serving the last known values — `fetchedAt` lets the caller age them.
 */
export async function getPlanUsage(): Promise<PlanUsage | undefined> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.value;

  inFlight ??= load().finally(() => {
    inFlight = undefined;
  });
  const loaded = await inFlight;
  if (loaded) cache = { value: loaded, fetchedAt: loaded.fetchedAt };
  return loaded ?? cache?.value;
}

export function resetCodexPlanUsageForTest(): void {
  cache = undefined;
  inFlight = undefined;
}
