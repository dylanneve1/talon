/**
 * Heartbeat agent — system-prompt + goal-block building, the one-shot agent
 * run with timeout/abort/orphan-eviction, and the per-run log helpers.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { files as pathFiles, dirs } from "../../../util/paths.js";
import { logError, logWarn } from "../../../util/log.js";
import { toYMD } from "../../../util/time.js";
import { getDefaultModel } from "../../models/catalog.js";
import { loadSystemTemplate } from "../../prompt/templates.js";
import { formatGoal, getOpenGoals } from "../../../storage/goal-store.js";
import type { OneShotAgentParams } from "../../types.js";
import { hb } from "./state.js";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute soft cap
const DEFAULT_HEARTBEAT_ABORT_GRACE_MS = 30 * 1000;
const HEARTBEAT_LOGS_DIR = resolve(dirs.logs, "heartbeats");

/**
 * Thrown when the heartbeat exceeds the configured timeout. Distinguishes
 * timeouts from agent-internal failures so callers can advance state on the
 * former (the hour was spent) but preserve it on the latter (retry as-is).
 */
export class HeartbeatTimeoutError extends Error {
  constructor() {
    super("Heartbeat agent timed out");
    this.name = "HeartbeatTimeoutError";
  }
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Overridable via env (eg integration tests). Read per RUN, not at module
 * load, so tests (and operators) can adjust without re-importing the module.
 */
function heartbeatTimeoutMs(): number {
  return envMs("TALON_HEARTBEAT_TIMEOUT_MS", DEFAULT_HEARTBEAT_TIMEOUT_MS);
}

/**
 * After we abort the agent on timeout, wait this long for the agent promise to
 * settle gracefully before releasing the lock and evicting orphans. Read per
 * run — see heartbeatTimeoutMs.
 */
function heartbeatAbortGraceMs(): number {
  return envMs(
    "TALON_HEARTBEAT_ABORT_GRACE_MS",
    DEFAULT_HEARTBEAT_ABORT_GRACE_MS,
  );
}

/**
 * Build the heartbeat agent system prompt from the package-owned template
 * `prompts/system/heartbeat-agent.md`. Names each `${frontend}-tools` MCP
 * server it actually has access to. Terminal-only deployments get a minimal
 * prompt (the `outbound` block is omitted); the `mempalace` block renders only
 * when the plugin is registered. Exported for tests.
 */
export function buildHeartbeatSystemPrompt(): string {
  const frontends = hb.config?.frontends ?? [];
  // trim: omitted {{#if}} blocks leave their tag lines' newlines behind.
  return loadSystemTemplate("heartbeat-agent", {
    mempalace: hb.config?.mempalace ? "yes" : undefined,
    outbound: frontends.length > 0 ? "yes" : undefined,
    toolList: frontends.map((f) => `\`${f}-tools\``).join(", "),
    exampleFrontend: frontends[0],
  }).trim();
}

/**
 * Render the open-goal listing for the heartbeat prompt. Cross-chat by design:
 * the heartbeat is a global agent, so it sees every chat's open goals (with
 * chat ids for routing updates back). Exported for tests.
 */
export function renderGoalsBlock(): { text: string; count: number } {
  let text = "(no open goals)";
  let count = 0;
  try {
    const goals = getOpenGoals();
    count = goals.length;
    if (count > 0) {
      text = goals.map((g) => formatGoal(g, { withChatId: true })).join("\n\n");
    }
  } catch (err) {
    logWarn(
      "heartbeat",
      `Failed to load goals for heartbeat prompt: ${err instanceof Error ? err.message : err}`,
    );
    text = "(goal store unavailable this run)";
  }
  return { text, count };
}

export async function runHeartbeatAgent(
  lastRunTimestamp: number,
  runCount: number,
): Promise<string> {
  const config = hb.config;
  if (!config) {
    throw new Error("Heartbeat agent not initialized");
  }

  const lastRunIso =
    lastRunTimestamp > 0 ? new Date(lastRunTimestamp).toISOString() : "never";

  const logsDir = dirs.logs;
  const memoryFile = pathFiles.memory;
  const workspace = config.workspace ?? dirs.workspace;
  const instructionsFile = resolve(workspace, "heartbeat-instructions.md");
  const dailyMemoryFile = resolve(dirs.dailyMemory, `${toYMD(new Date())}.md`);

  // Load prompt template from the prompts directory (seeded to ~/.talon/prompts/)
  const promptPath = resolve(dirs.prompts, "heartbeat.md");

  const goalsBlock = renderGoalsBlock();

  let prompt: string;
  let hadGoalsVar: boolean;
  try {
    const raw = readFileSync(promptPath, "utf-8");
    hadGoalsVar = raw.includes("{{goals}}");
    prompt = raw
      .replace(/\{\{workspace\}\}/g, workspace)
      .replace(/\{\{logsDir\}\}/g, logsDir)
      .replace(/\{\{lastRunIso\}\}/g, lastRunIso)
      .replace(/\{\{memoryFile\}\}/g, memoryFile)
      .replace(/\{\{instructionsFile\}\}/g, instructionsFile)
      .replace(/\{\{dailyMemoryFile\}\}/g, dailyMemoryFile)
      .replace(/\{\{runCount\}\}/g, String(runCount))
      .replace(/\{\{intervalMinutes\}\}/g, String(hb.intervalMinutesRef))
      .replace(/\{\{goals\}\}/g, goalsBlock.text);
  } catch {
    throw new Error(`Failed to read heartbeat prompt from ${promptPath}`);
  }

  // Seeded heartbeat.md copies predating the goals feature have no {{goals}}
  // placeholder — append the goals-fallback section so goals reach the agent
  // regardless of template vintage. Only when there ARE open goals.
  if (!hadGoalsVar && goalsBlock.count > 0) {
    prompt += `\n\n${loadSystemTemplate("heartbeat-agent", {
      mode: "goals-fallback",
      count: String(goalsBlock.count),
      goals: goalsBlock.text,
    }).trim()}`;
  }

  const model = config.heartbeatModel ?? config.model ?? getDefaultModel();

  const backend = config.getBackend?.() ?? null;
  const background = backend?.background;
  if (!background) {
    throw new Error(
      "Heartbeat requires a backend that implements the background capability",
    );
  }

  // Set up heartbeat log file
  const heartbeatLogFile = await createHeartbeatLogFile();
  await appendHeartbeatLog(
    heartbeatLogFile,
    `# Heartbeat Run #${runCount} — ${new Date().toISOString()}\n`,
  );
  await appendHeartbeatLog(
    heartbeatLogFile,
    `**Trigger:** ${lastRunIso === "never" ? "first run" : `last_run=${lastRunIso}`}, model=${model}\n`,
  );
  await appendHeartbeatLog(
    heartbeatLogFile,
    `**Prompt:**\n\`\`\`\n${prompt}\n\`\`\`\n\n---\n`,
  );

  // AbortController is the canonical way to signal a cancellation to a backend.
  // .abort() should tear down any spawned subprocess (Claude SDK) or stop
  // streaming (Kilo/OpenCode). We defend against backends that ignore it — see
  // heartbeatAbortGraceMs below.
  const abortController = new AbortController();

  const oneShotParams: OneShotAgentParams = {
    prompt,
    systemPrompt: buildHeartbeatSystemPrompt(),
    workspace,
    model,
    contextLabel: "heartbeat",
    abortController,
    appendLog: (text) => appendHeartbeatLog(heartbeatLogFile, text),
  };

  // Timeout that requests eviction (graceful first, force-kill on grace exit).
  let timeoutFired = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      timeoutFired = true;
      try {
        abortController.abort();
      } catch {
        /* ignore */
      }
      reject(new HeartbeatTimeoutError());
    }, heartbeatTimeoutMs());
    t.unref(); // Don't prevent Node.js from exiting cleanly during shutdown
    timeoutHandle = t;
  });

  const agentPromise = (async () => {
    await background.runOneShotAgent(oneShotParams);
    await appendHeartbeatLog(
      heartbeatLogFile,
      `\n---\n**Heartbeat #${runCount} completed at ${new Date().toISOString()}**\n`,
    );
  })();

  try {
    await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    // Snapshot timeout state and clear the timer immediately, BEFORE any awaits
    // in the error-handling path. Otherwise the timer can fire during the async
    // log append below and flip `timeoutFired` to true for what was actually a
    // non-timeout failure.
    const wasTimeout = timeoutFired;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    await appendHeartbeatLog(
      heartbeatLogFile,
      `\n---\n**Heartbeat #${runCount} FAILED at ${new Date().toISOString()}:** ${err}\n`,
    );
    if (wasTimeout) {
      // Give the backend a bounded grace window to clean up after the abort
      // signal — but never wait indefinitely. If the backend ignores the abort,
      // release the lock anyway and ask it to evict any orphan subprocesses.
      const settled = await raceWithTimeout(
        agentPromise.catch(() => "settled"),
        heartbeatAbortGraceMs(),
      );
      if (settled === "timed_out") {
        logWarn(
          "heartbeat",
          `Heartbeat #${runCount} backend ignored abort after ${heartbeatAbortGraceMs()}ms — releasing lock and evicting orphan subprocesses`,
        );
        // Fire-and-forget — we don't block the next heartbeat on subprocess
        // cleanup. Backends that don't spawn per-run subprocesses leave
        // evictOrphanSubprocesses unimplemented; that's fine.
        const evict = background.evictOrphanSubprocesses;
        if (evict) {
          evict("heartbeat").catch((sweepErr: unknown) => {
            logError("heartbeat", "Orphan subprocess sweep failed", sweepErr);
          });
        }
      }
    } else {
      // Non-timeout failure path — agentPromise has already settled.
      await agentPromise.catch(() => {});
    }
    throw err;
  } finally {
    // Safety net — already cleared in catch on the error path, but a clean
    // resolution of Promise.race() needs this too.
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return heartbeatLogFile;
}

/**
 * Race a promise against a timeout. Returns the promise's resolved value, or
 * the sentinel `"timed_out"` if the timeout fires first.
 *
 * NOTE: if `p` rejects before the timeout fires, that rejection propagates —
 * callers that need a never-throwing race should `.catch()` the input promise
 * themselves.
 */
async function raceWithTimeout<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | "timed_out"> {
  let t: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<"timed_out">((resolve) => {
        t = setTimeout(() => resolve("timed_out"), ms);
        t.unref();
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

// ── Logging helpers ─────────────────────────────────────────────────────────

async function createHeartbeatLogFile(): Promise<string> {
  // Best-effort: a failure to create the log directory must not abort the
  // heartbeat run itself. The per-append writes are already caught, so a
  // missing dir just means dropped log entries.
  try {
    if (!existsSync(HEARTBEAT_LOGS_DIR)) {
      await mkdir(HEARTBEAT_LOGS_DIR, { recursive: true });
    }
  } catch (err) {
    logError(
      "heartbeat",
      "Failed to create heartbeat log dir — run continues, log entries will be dropped",
      err,
    );
  }
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const seq = hb.logFileSequence++;
  return resolve(HEARTBEAT_LOGS_DIR, `heartbeat-${ts}-${seq}.md`);
}

async function appendHeartbeatLog(
  logFile: string,
  text: string,
): Promise<void> {
  try {
    await appendFile(logFile, text);
  } catch (err) {
    logError("heartbeat", "Failed to write heartbeat log", err);
  }
}
