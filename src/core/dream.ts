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
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { files as pathFiles, dirs } from "../util/paths.js";
import { log, logError, logWarn } from "../util/log.js";
import { getPluginMcpServers } from "./plugin.js";

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
const DREAM_LOGS_DIR = resolve(dirs.logs, "dreams");

// ── State ────────────────────────────────────────────────────────────────────

let dreaming = false; // in-process guard (one dream at a time)
let configRef: {
  model?: string;
  dreamModel?: string;
  claudeBinary?: string;
  workspace?: string;
  mempalace?: { pythonPath: string; palacePath: string };
} | null = null;

export function initDream(cfg: {
  model?: string;
  /** Override model used specifically for dream consolidation (e.g. haiku for cost savings). Falls back to main model. */
  dreamModel?: string;
  claudeBinary?: string;
  workspace?: string;
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
    writeDreamState({ last_run: Date.now(), status: "idle" });
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
'${configRef.mempalace.pythonPath.replace(/'/g, "'\\''")}' -m mempalace mine '${dirs.dailyMemory.replace(/'/g, "'\\''")}' --palace '${configRef.mempalace.palacePath.replace(/'/g, "'\\''")}' --mode convos --wing daily-notes
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

  const model = configRef.dreamModel ?? configRef.model ?? "claude-sonnet-4-6";
  const workspace = configRef.workspace ?? dirs.workspace;

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

  const options = {
    model,
    systemPrompt:
      "You are a background memory consolidation agent for Talon. Use only filesystem tools. Be precise and surgical — update memory.md without losing existing accurate information.",
    cwd: workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    ...(configRef.claudeBinary
      ? { pathToClaudeCodeExecutable: configRef.claudeBinary }
      : {}),
    // Include mempalace MCP servers when configured, otherwise empty
    mcpServers: configRef.mempalace ? getPluginMcpServers("", "dream") : {},
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
    setTimeout(
      () => reject(new Error("Dream agent timed out")),
      DREAM_TIMEOUT_MS,
    ),
  );

  const agentPromise = (async () => {
    const qi = query({
      prompt,
      options: options as Parameters<typeof query>[0]["options"],
    });
    for await (const msg of qi) {
      logDreamMessage(dreamLogFile, msg);
    }
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
    throw err;
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

function logDreamMessage(logFile: string, msg: SDKMessage): void {
  try {
    const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS

    switch (msg.type) {
      case "assistant": {
        // Extract text content from the assistant message
        const textBlocks = msg.message.content
          .filter((b) => b.type === "text")
          .map((b) => ("text" in b ? (b as { text: string }).text : ""));
        const toolUseBlocks = msg.message.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            const tu = b as { name: string; input: unknown };
            return `**Tool call:** \`${tu.name}\`\n\`\`\`json\n${JSON.stringify(tu.input, null, 2)}\n\`\`\``;
          });

        if (textBlocks.length > 0) {
          appendDreamLog(
            logFile,
            `\n## [${ts}] Assistant\n${textBlocks.join("\n")}\n`,
          );
        }
        if (toolUseBlocks.length > 0) {
          appendDreamLog(logFile, `\n${toolUseBlocks.join("\n\n")}\n`);
        }
        break;
      }
      case "result": {
        // Final result of the dream agent run
        const result =
          "result" in msg
            ? (msg as { result: string }).result
            : JSON.stringify(msg);
        const truncated =
          result.length > 2000
            ? result.slice(0, 2000) + "\n... (truncated)"
            : result;
        appendDreamLog(
          logFile,
          `\n### [${ts}] Result (${msg.subtype})\n\`\`\`\n${truncated}\n\`\`\`\n`,
        );
        break;
      }
      case "system": {
        appendDreamLog(logFile, `\n### [${ts}] System (${msg.subtype})\n`);
        break;
      }
      case "user": {
        // Tool results come back as user messages
        if (msg.tool_use_result != null) {
          const raw =
            typeof msg.tool_use_result === "string"
              ? msg.tool_use_result
              : JSON.stringify(msg.tool_use_result, null, 2);
          const truncated =
            raw.length > 2000 ? raw.slice(0, 2000) + "\n... (truncated)" : raw;
          appendDreamLog(
            logFile,
            `\n### [${ts}] Tool Result\n\`\`\`\n${truncated}\n\`\`\`\n`,
          );
        }
        break;
      }
      default:
        // Skip stream_event and other noisy message types
        break;
    }
  } catch {
    // Don't let logging errors break the dream
  }
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
