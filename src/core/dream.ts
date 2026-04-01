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
import { resolve } from "node:path";
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
  if (dreaming) return; // already running

  const state = readDreamState();

  // Check if it's been long enough since the last dream
  const now = Date.now();
  const elapsed = now - (state?.last_run ?? 0);
  if (elapsed < DREAM_INTERVAL_MS) return;

  // Claim the lock immediately to prevent duplicate dreams
  dreaming = true;
  writeDreamState({ last_run: now, status: "running" });
  log("dream", `Triggering memory consolidation (last run: ${state?.last_run ? new Date(state.last_run).toISOString() : "never"})`);

  // Fire and forget — runs in the background
  runDreamAgent(state?.last_run ?? 0)
    .then(() => {
      writeDreamState({ last_run: Date.now(), status: "idle" });
      log("dream", "Memory consolidation complete");
    })
    .catch((err) => {
      logError("dream", "Memory consolidation failed", err);
      // Reset status so the next invocation can retry
      writeDreamState({ last_run: Date.now(), status: "idle" });
    })
    .finally(() => {
      dreaming = false;
    });
}

/**
 * Force a dream run immediately, regardless of the 12-hour interval.
 * Returns a promise that resolves when the dream completes (or rejects on failure).
 * Throws if a dream is already running.
 */
export async function forceDream(): Promise<void> {
  if (dreaming) throw new Error("Dream already running");

  const state = readDreamState();
  const now = Date.now();

  dreaming = true;
  writeDreamState({ last_run: now, status: "running" });
  log("dream", `Force-triggering memory consolidation (last run: ${state?.last_run ? new Date(state.last_run).toISOString() : "never"})`);

  try {
    await runDreamAgent(state?.last_run ?? 0);
    writeDreamState({ last_run: Date.now(), status: "idle" });
    log("dream", "Memory consolidation complete (forced)");
  } catch (err) {
    logError("dream", "Memory consolidation failed (forced)", err);
    writeDreamState({ last_run: Date.now(), status: "idle" });
    throw err;
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

  const prompt = `You are Talon's background memory consolidation agent. Your job is to update the persistent memory file with new information learned from recent interaction logs.

You have access ONLY to filesystem tools (Read, Write, Edit, Bash, Glob, Grep). Do NOT attempt to use any Telegram, MCP, or messaging tools.

## Your 4-stage task

### Stage 1 — Orient
- Read \`${dreamStateFile}\` to confirm \`last_run\` timestamp
- List log files in \`${logsDir}/\` that are dated on or after \`${lastRunIso}\`
- If there are no new log files, update dream_state.json status to "idle" and stop

### Stage 2 — Gather
- Read each new log file
- Each log file uses this format:
  - User messages appear as \`## HH:MM -- [Username]\` followed by the full message text
  - Bot responses appear as \`## HH:MM -- [Talon]\` followed by what was sent
  - System entries (e.g. new users) appear as \`## HH:MM -- [System]\`
- Extract any new information:
  - User facts, preferences, personality traits
  - Project names, technical details, URLs, file paths
  - Notable events or conversations
  - Corrections to previously held beliefs
  - Operational patterns (e.g. who stays up late, who prefers what tools)
  - Project context changes inferred from the conversation (e.g. new repos, shifted priorities)
- Be selective — only extract genuinely new or updated information

### Stage 3 — Consolidate
- Read the current memory file at \`${memoryFile}\`
- Merge new information into the appropriate sections
- Update existing entries if new info contradicts or extends them
- Add new entries where appropriate
- Keep entries concise and factual — no padding, no narrative
- Preserve all existing structure and sections

### Stage 4 — Prune
- Remove entries that have been explicitly contradicted
- Remove entries that are clearly stale or irrelevant
- Do NOT remove entries just because they're old — only remove if wrong or superseded
- Write the updated memory.md back to \`${memoryFile}\`

When done, your final action is to write \`{ "last_run": <current_unix_ms>, "status": "idle" }\` to \`${dreamStateFile}\`.`;

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
