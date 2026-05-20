/**
 * Antigravity model discovery.
 *
 * Spawns `list_models.py` to enumerate the chat-capable Gemini models
 * the configured API key actually has access to. Results are cached
 * for the process lifetime (a single 5-min TTL refresh on demand).
 *
 * The Gemini catalog isn't static — Google adds models monthly and
 * which ones a given API key sees depends on billing tier + region.
 * Hard-coding the list (as v0 of this backend did) is technical debt
 * Dylan called out; this is the fix.
 *
 * Fallback: if discovery fails (no key, network error, venv missing),
 * we surface a small built-in fallback list so `/model` still has
 * SOMETHING to show and `setChatModel` still works. The fallback is
 * the same shape as the dynamic results so the catalog consumer
 * doesn't need to special-case anything.
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { log, logWarn, logError } from "../../util/log.js";
import type { UnifiedModelInfo } from "../../core/types.js";

const HERE = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

function resolveListModelsScript(): string {
  const distSibling = resolve(HERE, "python", "list_models.py");
  if (existsSync(distSibling)) return distSibling;
  const srcSibling = resolve(
    HERE,
    "../../../src/backend/antigravity/python/list_models.py",
  );
  if (existsSync(srcSibling)) return srcSibling;
  return distSibling;
}

function resolvePythonPath(override?: string): string {
  const candidates: string[] = [];
  if (override) candidates.push(override);
  const home = homedir();
  candidates.push(resolve(home, ".talon-antigravity/venv/bin/python3"));
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return "python3";
}

interface DiscoveredModelRaw {
  id: string;
  name: string;
  displayName: string;
  inputTokenLimit: number;
  outputTokenLimit: number;
  supportsThinking: boolean;
  supportedActions: string[];
}

interface DiscoveryResult {
  models: UnifiedModelInfo[];
  fetchedAt: number;
  source: "live" | "fallback";
  error?: string;
}

// Cache for the process lifetime. /model refresh can call
// `refreshAntigravityCatalog()` to bypass.
let cache: DiscoveryResult | null = null;
let inFlight: Promise<DiscoveryResult> | null = null;

/** Curated fallback when discovery fails. Mirrors the v0 hardcoded list. */
const FALLBACK_MODELS: UnifiedModelInfo[] = [
  {
    id: "models/gemini-3.5-flash",
    displayName: "Gemini 3.5 Flash",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 1_000_000,
  },
  {
    id: "models/gemini-3-pro",
    displayName: "Gemini 3 Pro",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 2_000_000,
  },
  {
    id: "models/gemini-3.5-pro",
    displayName: "Gemini 3.5 Pro",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 2_000_000,
  },
  {
    id: "models/gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 1_000_000,
  },
  {
    id: "models/gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    provider: "google",
    providerName: "Google",
    selectable: true,
    reasoning: true,
    contextWindow: 2_000_000,
  },
];

function fallbackResult(error?: string): DiscoveryResult {
  return {
    models: FALLBACK_MODELS,
    fetchedAt: Date.now(),
    source: "fallback",
    error,
  };
}

function isCacheFresh(): boolean {
  if (!cache) return false;
  const fiveMinutes = 5 * 60 * 1000;
  return Date.now() - cache.fetchedAt < fiveMinutes;
}

interface DiscoveryOptions {
  apiKey?: string;
  pythonPath?: string;
  /** Skip the cache; force a fresh subprocess call. */
  force?: boolean;
  /** Override the list_models.py path (test isolation). */
  scriptPathOverride?: string;
}

/**
 * Discover the live model catalog. Falls back to a curated list if
 * the subprocess fails or no API key is configured.
 *
 * Concurrent callers see the same in-flight Promise (deduped).
 */
export function discoverAntigravityModels(
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  if (!opts.force && isCacheFresh() && cache) {
    return Promise.resolve(cache);
  }
  // Only piggy-back on the in-flight promise when we're NOT forcing
  // a refresh — force=true callers want a fresh subprocess call no
  // matter what.
  if (!opts.force && inFlight) return inFlight;

  // `myFlight` is read inside the `finally` clause below to decide
  // whether this run still owns the shared `inFlight` marker. The
  // top-level `await Promise.resolve()` guarantees the variable is
  // initialised before any `finally` execution.
  let myFlight!: Promise<DiscoveryResult>;
  myFlight = (async (): Promise<DiscoveryResult> => {
    // Wait one microtask so `myFlight` is assigned (and `inFlight`
    // is set below). Without this, the `finally` clause below
    // dereferences an uninitialised TDZ binding in the synchronous
    // no-await branches.
    await Promise.resolve();
    try {
      const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        const result = fallbackResult("no API key configured");
        cache = result;
        return result;
      }

      const result = await runListModels(
        apiKey,
        opts.pythonPath,
        opts.scriptPathOverride,
      );
      cache = result;
      return result;
    } finally {
      // Only clear the shared marker if it still references THIS run
      // — a subsequent force-refresh may have overwritten it.
      if (inFlight === myFlight) {
        inFlight = null;
      }
    }
  })();
  inFlight = myFlight;
  return myFlight;
}

/** Get the current cached catalog without spawning a subprocess. */
export function getCachedAntigravityModels(): UnifiedModelInfo[] {
  return (cache ?? fallbackResult()).models;
}

/** Force a refresh on the next discoverAntigravityModels() call. */
export function refreshAntigravityCatalog(): void {
  cache = null;
}

/** For tests — reset cache + in-flight state. */
export function resetDiscoveryStateForTests(): void {
  cache = null;
  inFlight = null;
}

async function runListModels(
  apiKey: string,
  pythonPathOverride?: string,
  scriptPathOverride?: string,
): Promise<DiscoveryResult> {
  const pythonPath = resolvePythonPath(pythonPathOverride);
  const scriptPath = scriptPathOverride ?? resolveListModelsScript();
  if (!existsSync(scriptPath)) {
    logWarn(
      "agent",
      `Antigravity: list_models.py not found at ${scriptPath}, falling back to curated catalog`,
    );
    return fallbackResult("list_models.py missing");
  }

  return new Promise<DiscoveryResult>((resolveOuter) => {
    const proc = spawn(pythonPath, [scriptPath, "--api-key-fd", "3"], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });

    const fdWriter = proc.stdio[3] as NodeJS.WritableStream | undefined;
    if (!fdWriter) {
      proc.kill();
      resolveOuter(fallbackResult("fd 3 unavailable on spawn"));
      return;
    }
    fdWriter.write(apiKey);
    fdWriter.end();

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    // Cap discovery time so a hung Python subprocess doesn't wedge
    // `/model` rendering forever.
    const timeoutHandle = setTimeout(() => {
      proc.kill("SIGTERM");
      resolveOuter(fallbackResult("list_models.py timed out after 15s"));
    }, 15_000);

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      resolveOuter(fallbackResult(`spawn error: ${err.message}`));
    });

    proc.on("exit", (code) => {
      clearTimeout(timeoutHandle);
      try {
        const trimmed = stdout.trim();
        if (!trimmed) {
          logWarn(
            "agent",
            `Antigravity discovery: empty stdout (exit ${code}, stderr: ${stderr.slice(0, 200)})`,
          );
          resolveOuter(fallbackResult(`empty stdout (exit ${code})`));
          return;
        }
        const parsed = JSON.parse(trimmed) as
          | { ok: true; models: DiscoveredModelRaw[] }
          | { ok: false; error: string };
        if (!parsed.ok) {
          if (code !== 0) {
            logWarn("agent", `Antigravity discovery failed: ${parsed.error}`);
          }
          resolveOuter(fallbackResult(parsed.error));
          return;
        }

        const unified: UnifiedModelInfo[] = parsed.models.map((m) => ({
          id: m.id,
          displayName: m.displayName,
          provider: "google",
          providerName: "Google",
          selectable: true,
          reasoning: m.supportsThinking,
          contextWindow: m.inputTokenLimit > 0 ? m.inputTokenLimit : undefined,
        }));

        // Sort: newest-generation Pro models first, then Flash, then
        // older generations. Heuristic by digit content of the name.
        unified.sort((a, b) => byModelTier(a) - byModelTier(b));

        log(
          "agent",
          `Antigravity discovery: ${unified.length} models live from Gemini API`,
        );
        resolveOuter({
          models: unified,
          fetchedAt: Date.now(),
          source: "live",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(
          "agent",
          `Antigravity discovery: parse failed (${msg}); stdout=${stdout.slice(0, 200)}`,
        );
        resolveOuter(fallbackResult(`parse failed: ${msg}`));
      }
    });
  });
}

/**
 * Loose ordering of Gemini variants for /model presentation. Pulls
 * the highest version + "pro"-marked entries to the top, "flash"
 * after, "lite"/"mini" last. Returns a sort key (lower = higher in
 * the list).
 */
function byModelTier(m: UnifiedModelInfo): number {
  const id = m.id.toLowerCase();
  // Strip "models/" prefix Gemini uses on canonical IDs.
  const trimmed = id.replace(/^models\//, "");

  // Pull a major.minor version out of the id.
  const versionMatch = trimmed.match(/(\d+(?:\.\d+)?)/);
  const version = versionMatch ? parseFloat(versionMatch[1]) : 0;

  let tier = 0;
  if (trimmed.includes("pro")) tier = 0;
  else if (trimmed.includes("flash")) tier = 100;
  else if (trimmed.includes("lite") || trimmed.includes("mini")) tier = 200;
  else tier = 300;

  // Higher version → lower sort key (sort ascending), so we negate.
  return tier - version * 10;
}
