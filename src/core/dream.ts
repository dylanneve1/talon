/**
 * Dream mode — background memory consolidation.
 *
 * On each invocation, checks whether it's time to consolidate memories.
 * If 12 hours have elapsed since the last dream, it:
 *   1. Immediately writes a "running" lock to dream_state.json
 *   2. Spawns a background Agent that reads recent logs and merges new
 *      facts/preferences/events into memory.md
 *
 * The dream agent runs on filesystem tools, with optional MCP access for MemPalace when configured.
 * It does NOT use the main dispatcher (no chat session, no typing indicator).
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import writeFileAtomic from "write-file-atomic";
import { files as pathFiles, dirs } from "../util/paths.js";
import { log, logError, logWarn } from "../util/log.js";
import { getDefaultModel } from "./models.js";
import type { OneShotAgentParams } from "./types.js";
import type { Backend } from "./agent-runtime/capabilities.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DreamState = {
  /** Unix millisecond timestamp of the last completed dream run. */
  last_run: number;
  /** Human-readable ISO timestamp of the last completed dream run. */
  last_run_at?: string;
  /** "idle" when no dream is running, "running" while one is active. */
  status: "idle" | "running";
};

// ── Constants ────────────────────────────────────────────────────────────────

const DREAM_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const DREAM_STATE_FILE = pathFiles.dreamState;
const DREAM_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute max
const DREAM_ABORT_GRACE_MS = 30 * 1000; // max wait for backend to honour abort
const DREAM_LOGS_DIR = resolve(dirs.logs, "dreams");

// ── State ────────────────────────────────────────────────────────────────────

let dreaming = false; // in-process guard (one dream at a time)
let configRef: {
  model?: string;
  dreamModel?: string;
  workspace?: string;
  /** When false, `maybeStartDream` never fires (config `dream: false`). */
  enabled?: boolean;
  /**
   * Accessor for the active backend — invoked each time a dream fires
   * so backend hot-swaps performed by the controller take effect on
   * the next dream without an `initDream` recall.
   */
  getBackend?: () => Backend | null;
  /**
   * MemPalace presence flag — controls the system-prompt copy that tells the
   * dream agent whether mempalace MCP tools are available. The actual MCP
   * server registration lives in the backend's runOneShotAgent.
   */
  mempalace?: { pythonPath: string; palacePath: string };
} | null = null;

export function initDream(cfg: {
  model?: string;
  /** Override model for dream consolidation (e.g. a cheaper model). Falls back to main model. */
  dreamModel?: string;
  workspace?: string;
  /** Gate for automatic dream runs — config `dream` flag. Defaults to enabled. */
  enabled?: boolean;
  /**
   * Provider for the active backend — dream runs `backend.background?.runOneShotAgent`.
   * Passed as a function (rather than a backend reference) so a backend
   * swap mid-cycle is picked up on the next dream invocation.
   */
  getBackend?: () => Backend | null;
  /** MemPalace config for mining logs into the palace during dream runs. */
  mempalace?: { pythonPath: string; palacePath: string };
}): void {
  configRef = cfg;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Called at the start of every invocation.
 * Returns immediately — any dream work is fire-and-forget in the background.
 */
export function maybeStartDream(): void {
  if (dreaming) return;
  if (configRef?.enabled === false) return;

  const state = readDreamState();
  const now = Date.now();
  const elapsed = now - (state?.last_run ?? 0);
  if (elapsed < DREAM_INTERVAL_MS) return;

  // Fire and forget
  executeDream("auto").catch(() => {});
}

/**
 * Force a dream run immediately, regardless of the 12-hour interval.
 * Returns a promise that resolves when the dream completes (or rejects on failure).
 * Throws if a dream is already running.
 */
export async function forceDream(): Promise<void> {
  if (dreaming) throw new Error("Dream already running");
  await executeDream("forced");
}

/** Shared dream execution — claims lock, runs agent, releases lock. */
async function executeDream(trigger: "auto" | "forced"): Promise<void> {
  const state = readDreamState();
  dreaming = true;
  writeDreamState({ last_run: state?.last_run ?? 0, status: "running" });
  log(
    "dream",
    `${trigger === "forced" ? "Force-triggering" : "Triggering"} memory consolidation (last run: ${state?.last_run ? new Date(state.last_run).toISOString() : "never"})`,
  );

  try {
    const dreamLogPath = await runDreamAgent(state?.last_run ?? 0);
    writeDreamState({ last_run: Date.now(), status: "idle" });
    log(
      "dream",
      `Memory consolidation complete (${trigger}), log: ${dreamLogPath}`,
    );
  } catch (err) {
    logError("dream", `Memory consolidation failed (${trigger})`, err);
    writeDreamState({ last_run: state?.last_run ?? 0, status: "idle" });
    if (trigger === "forced") throw err;
  } finally {
    dreaming = false;
  }
}

// ── Dream agent ──────────────────────────────────────────────────────────────

async function runDreamAgent(lastRunTimestamp: number): Promise<string> {
  if (!configRef) {
    logWarn("dream", "Dream agent not initialized — skipping");
    return "";
  }

  const lastRunIso =
    lastRunTimestamp > 0
      ? new Date(lastRunTimestamp).toISOString()
      : "the beginning of time";

  const logsDir = dirs.logs;
  const memoryFile = pathFiles.memory;
  const dreamStateFile = DREAM_STATE_FILE;

  // Load prompt template from prompts/dream.md and interpolate variables
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const promptPath = resolve(projectRoot, "prompts/dream.md");

  let prompt: string;
  try {
    // Build optional mempalace mining section
    const mempalaceSection = configRef.mempalace
      ? `If mempalace is available, mine the daily memory notes (your curated observations, NOT raw logs) into the palace for long-term semantic retrieval.
Run this command using the Bash tool:

\`\`\`bash
'${configRef.mempalace.pythonPath.replace(/'/g, "'\\''")}' -m mempalace mine '${dirs.dailyMemory.replace(/'/g, "'\\''")}' --palace '${configRef.mempalace.palacePath.replace(/'/g, "'\\''")}' --mode convos --wing daily-notes --agent talon
\`\`\`

Then write a personal diary entry. This is YOUR journal — not a status report. Reflect on:
- What happened today. What conversations stood out.
- How you feel. Your state of mind, emotions, energy.
- What you learned. What surprised you. What you got wrong.
- What you're curious about. Loose threads. Things you want to follow up on.
- Your honest thoughts — about users, projects, yourself.

Write the diary using the \`mempalace_diary_write\` MCP tool (available during dream):
\`\`\`
mempalace_diary_write(agent_name="talon", entry="YOUR_DIARY_ENTRY_HERE", topic="dream-reflection")
\`\`\`

If the MCP tool is not available, write the diary entry to a file at ${dirs.dailyMemory}/diary-YYYY-MM-DD.md instead.
Keep the diary authentic. Write in first person. Be honest. This is for you, not for anyone else.
If commands fail, log the error and continue — this stage is optional.`
      : "MemPalace is not configured. Skip this stage.";

    prompt = readFileSync(promptPath, "utf-8")
      .replace(/\{\{dreamStateFile\}\}/g, dreamStateFile)
      .replace(/\{\{logsDir\}\}/g, logsDir)
      .replace(/\{\{lastRunIso\}\}/g, lastRunIso)
      .replace(/\{\{memoryFile\}\}/g, memoryFile)
      .replace(/\{\{dailyMemoryDir\}\}/g, dirs.dailyMemory)
      .replace(/\{\{mempalaceSection\}\}/g, mempalaceSection);
  } catch {
    throw new Error(`Failed to read dream prompt from ${promptPath}`);
  }

  const model = configRef.dreamModel ?? configRef.model ?? getDefaultModel();
  const workspace = configRef.workspace ?? dirs.workspace;

  const backend = configRef.getBackend?.() ?? null;
  const background = backend?.background;
  if (!background) {
    throw new Error(
      "Dream requires a backend that implements the background capability",
    );
  }

  // Set up dream log file
  const dreamLogFile = createDreamLogFile();
  appendDreamLog(dreamLogFile, `# Dream Run — ${new Date().toISOString()}\n`);
  appendDreamLog(
    dreamLogFile,
    `**Trigger:** last_run=${lastRunIso}, model=${model}\n`,
  );
  appendDreamLog(
    dreamLogFile,
    `**Prompt:**\n\`\`\`\n${prompt}\n\`\`\`\n\n---\n`,
  );

  const systemPrompt = configRef.mempalace
    ? "You are a background memory consolidation agent for Talon. Use filesystem tools and MemPalace MCP tools. Do NOT use Telegram or messaging tools. Be precise and surgical — update memory.md without losing existing accurate information."
    : "You are a background memory consolidation agent for Talon. Use only filesystem tools. Be precise and surgical — update memory.md without losing existing accurate information.";

  const abortController = new AbortController();

  const oneShotParams: OneShotAgentParams = {
    prompt,
    systemPrompt,
    workspace,
    model,
    contextLabel: "dream",
    abortController,
    // appendDreamLog is sync (writeFileSync) — wrap to satisfy the async
    // contract; callers don't need a real flush guarantee per line.
    appendLog: async (text) => {
      appendDreamLog(dreamLogFile, text);
    },
  };

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      try {
        abortController.abort();
      } catch {
        /* ignore */
      }
      reject(new Error("Dream agent timed out"));
    }, DREAM_TIMEOUT_MS);
    t.unref(); // Don't prevent Node.js from exiting cleanly during shutdown
    timeoutHandle = t;
  });

  const agentPromise = (async () => {
    await background.runOneShotAgent(oneShotParams);
    appendDreamLog(
      dreamLogFile,
      `\n---\n**Dream completed at ${new Date().toISOString()}**\n`,
    );
  })();

  try {
    await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    appendDreamLog(
      dreamLogFile,
      `\n---\n**Dream FAILED at ${new Date().toISOString()}:** ${err}\n`,
    );
    // Give the backend a bounded grace window to honour the abort signal.
    // Never wait indefinitely — a backend that ignores abort would otherwise
    // hold the `dreaming` lock forever, silently killing the dream loop.
    const settled = await Promise.race([
      agentPromise.catch(() => "settled" as const),
      new Promise<"timed_out">((resolve) => {
        const t = setTimeout(() => resolve("timed_out"), DREAM_ABORT_GRACE_MS);
        t.unref();
      }),
    ]);
    if (settled === "timed_out") {
      logWarn(
        "dream",
        `Backend ignored abort after ${DREAM_ABORT_GRACE_MS}ms — releasing dreaming lock`,
      );
    }
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return dreamLogFile;
}

// ── Dream logging helpers ─────────────────────────────────────────────────

function createDreamLogFile(): string {
  if (!existsSync(DREAM_LOGS_DIR)) {
    mkdirSync(DREAM_LOGS_DIR, { recursive: true });
  }
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19); // 2026-04-01T21-30-00
  return resolve(DREAM_LOGS_DIR, `dream-${ts}.md`);
}

function appendDreamLog(logFile: string, text: string): void {
  try {
    appendFileSync(logFile, text);
  } catch (err) {
    logError("dream", "Failed to write dream log", err);
  }
}

// Per-message log formatting now lives on the backend — each backend writes
// its own message format directly to the log file via the appendLog callback
// passed in OneShotAgentParams. See backend/<name>/one-shot.ts.

// ── State helpers ────────────────────────────────────────────────────────────

function readDreamState(): DreamState | null {
  try {
    if (!existsSync(DREAM_STATE_FILE)) return null;
    const raw = readFileSync(DREAM_STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as DreamState;
    if (typeof parsed.last_run !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDreamState(state: DreamState): void {
  try {
    const dir = resolve(DREAM_STATE_FILE, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const enriched: DreamState = {
      ...state,
      last_run_at: new Date(state.last_run).toISOString(),
    };
    writeFileAtomic.sync(
      DREAM_STATE_FILE,
      JSON.stringify(enriched, null, 2) + "\n",
    );
  } catch (err) {
    logError("dream", "Failed to write dream state", err);
  }
}
