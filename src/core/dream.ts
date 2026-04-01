/**
 * Dream mode — background memory consolidation.
 *
 * On each invocation, checks whether it's time to consolidate memories.
 * If 12 hours have elapsed since the last dream, it:
 *   1. Immediately writes a "running" lock to dream_state.json
 *   2. Spawns a background Agent that reads recent logs and merges new
 *      facts/preferences/events into memory.md
 *
 * The dream agent runs entirely on filesystem tools — no Telegram/MCP access.
 * It does NOT use the main dispatcher (no chat session, no typing indicator).
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import writeFileAtomic from "write-file-atomic";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { files as pathFiles, dirs } from "../util/paths.js";
import { log, logError, logWarn } from "../util/log.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type DreamState = {
  /** Unix millisecond timestamp of the last completed dream run. */
  last_run: number;
  /** "idle" when no dream is running, "running" while one is active. */
  status: "idle" | "running";
};

// ── Constants ────────────────────────────────────────────────────────────────

const DREAM_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const DREAM_STATE_FILE = pathFiles.dreamState;
const DREAM_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute max

// ── State ────────────────────────────────────────────────────────────────────

let dreaming = false; // in-process guard (one dream at a time)
let configRef: { model?: string; dreamModel?: string; claudeBinary?: string; workspace?: string } | null = null;

export function initDream(cfg: {
  model?: string;
  /** Override model used specifically for dream consolidation (e.g. haiku for cost savings). Falls back to main model. */
  dreamModel?: string;
  claudeBinary?: string;
  workspace?: string;
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
  const now = Date.now();

  dreaming = true;
  writeDreamState({ last_run: now, status: "running" });
  log("dream", `${trigger === "forced" ? "Force-triggering" : "Triggering"} memory consolidation (last run: ${state?.last_run ? new Date(state.last_run).toISOString() : "never"})`);

  try {
    await runDreamAgent(state?.last_run ?? 0);
    writeDreamState({ last_run: Date.now(), status: "idle" });
    log("dream", `Memory consolidation complete (${trigger})`);
  } catch (err) {
    logError("dream", `Memory consolidation failed (${trigger})`, err);
    writeDreamState({ last_run: Date.now(), status: "idle" });
    if (trigger === "forced") throw err;
  } finally {
    dreaming = false;
  }
}

// ── Dream agent ──────────────────────────────────────────────────────────────

async function runDreamAgent(lastRunTimestamp: number): Promise<void> {
  if (!configRef) {
    logWarn("dream", "Dream agent not initialized — skipping");
    return;
  }

  const lastRunIso = lastRunTimestamp > 0
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
    prompt = readFileSync(promptPath, "utf-8")
      .replace(/\{\{dreamStateFile\}\}/g, dreamStateFile)
      .replace(/\{\{logsDir\}\}/g, logsDir)
      .replace(/\{\{lastRunIso\}\}/g, lastRunIso)
      .replace(/\{\{memoryFile\}\}/g, memoryFile);
  } catch {
    throw new Error(`Failed to read dream prompt from ${promptPath}`);
  }

  const model = configRef.dreamModel ?? configRef.model ?? "claude-sonnet-4-6";
  const workspace = configRef.workspace ?? dirs.workspace;

  const options = {
    model,
    systemPrompt: "You are a background memory consolidation agent for Talon. Use only filesystem tools. Be precise and surgical — update memory.md without losing existing accurate information.",
    cwd: workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    ...(configRef.claudeBinary
      ? { pathToClaudeCodeExecutable: configRef.claudeBinary }
      : {}),
    // No MCP servers — filesystem tools only
    mcpServers: {},
    disallowedTools: [
      "EnterPlanMode",
      "ExitPlanMode",
      "EnterWorktree",
      "ExitWorktree",
      "TodoWrite",
      "TodoRead",
      "TaskCreate",
      "TaskUpdate",
      "TaskGet",
      "TaskList",
      "TaskOutput",
      "TaskStop",
      "AskUserQuestion",
      "Agent",
    ],
  };

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Dream agent timed out")), DREAM_TIMEOUT_MS),
  );

  const agentPromise = (async () => {
    const qi = query({
      prompt,
      options: options as Parameters<typeof query>[0]["options"],
    });
    // Drain the stream — we don't need the output, just completion
    for await (const _ of qi) { /* consume */ }
  })();

  await Promise.race([agentPromise, timeoutPromise]);
}

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
    writeFileAtomic.sync(DREAM_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    logError("dream", "Failed to write dream state", err);
  }
}
