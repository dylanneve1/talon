/**
 * Heartbeat — periodic background agent for user-defined maintenance tasks.
 *
 * Runs at a configurable interval (default: 60 minutes).
 * The agent reads instructions from ~/.talon/workspace/heartbeat-instructions.md
 * and executes them using filesystem tools and all loaded MCP plugins.
 *
 * Modeled after dream.ts but more general-purpose.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { files as pathFiles, dirs } from "../util/paths.js";
import { log, logError, logWarn } from "../util/log.js";
import { toYMD } from "../util/time.js";
import { getPluginMcpServers } from "./plugin.js";
import { DISALLOWED_TOOLS_BACKGROUND } from "./constants.js";
import { getDefaultModel } from "./models.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type HeartbeatState = {
  /** Unix millisecond timestamp of the last successfully completed heartbeat run. */
  last_run: number;
  /** Human-readable ISO timestamp of the last successfully completed heartbeat run. */
  last_run_at?: string;
  /** Unix millisecond timestamp of the last time a heartbeat was started (success or failure). */
  last_started?: number;
  /** "idle" when no heartbeat is running, "running" while one is active. */
  status: "idle" | "running";
  /** Total number of successfully completed heartbeat runs. */
  run_count: number;
};

// ── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_STATE_FILE = pathFiles.heartbeatState;
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute max
const HEARTBEAT_LOGS_DIR = resolve(dirs.logs, "heartbeats");
const STARTUP_DELAY_MS = 5 * 60 * 1000; // 5-minute delay before first run

// ── State ────────────────────────────────────────────────────────────────────

let running = false; // in-process guard (one heartbeat at a time)
let currentRunPromise: Promise<void> | null = null; // tracks in-flight run for graceful shutdown
let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let intervalMinutesRef = 60; // stored from startHeartbeatTimer
let configRef: {
  model?: string;
  heartbeatModel?: string;
  claudeBinary?: string;
  workspace?: string;
} | null = null;

export function initHeartbeat(cfg: {
  model?: string;
  /** Override model for heartbeat (e.g. a cheaper model). Falls back to main model. */
  heartbeatModel?: string;
  claudeBinary?: string;
  workspace?: string;
}): void {
  configRef = cfg;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the heartbeat timer. First run happens after a 5-minute startup delay,
 * then repeats at the configured interval.
 */
export function startHeartbeatTimer(intervalMinutes: number): void {
  if (timer || startupTimer) return; // already running or scheduled to start

  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    logWarn(
      "heartbeat",
      `Refusing to start heartbeat timer with invalid intervalMinutes: ${intervalMinutes}`,
    );
    return;
  }

  intervalMinutesRef = intervalMinutes;
  const intervalMs = intervalMinutes * 60 * 1000;
  log(
    "heartbeat",
    `Starting heartbeat timer (every ${intervalMinutes}min, first run in 5min)`,
  );

  startupTimer = setTimeout(() => {
    startupTimer = null;
    // Run immediately after startup delay
    executeHeartbeat("auto").catch(() => {});

    // Then set up the recurring interval
    timer = setInterval(() => {
      executeHeartbeat("auto").catch(() => {});
    }, intervalMs);
  }, STARTUP_DELAY_MS);
}

/**
 * Stop the heartbeat timer. Does not wait for in-flight runs.
 * Use awaitCurrentRun() after this to wait for a running heartbeat to finish.
 */
export function stopHeartbeatTimer(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    log("heartbeat", "Heartbeat timer stopped");
  }
}

/**
 * Wait for any in-flight heartbeat run to complete.
 * Call after stopHeartbeatTimer() during graceful shutdown.
 */
export async function awaitCurrentRun(timeoutMs = 10_000): Promise<void> {
  if (currentRunPromise) {
    log("heartbeat", "Waiting for in-flight heartbeat to complete...");
    try {
      await Promise.race([
        currentRunPromise,
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            logWarn(
              "heartbeat",
              "In-flight heartbeat did not finish within shutdown budget, proceeding",
            );
            resolve();
          }, timeoutMs);
          t.unref();
        }),
      ]);
    } catch {
      // Already logged in executeHeartbeat
    }
  }
}

/**
 * Force a heartbeat run immediately.
 * Returns a promise that resolves when the heartbeat completes.
 * Throws if a heartbeat is already running.
 */
export async function forceHeartbeat(): Promise<void> {
  if (running) throw new Error("Heartbeat already running");
  await executeHeartbeat("forced");
}

/**
 * Get the current heartbeat status.
 */
export function getHeartbeatStatus(): HeartbeatState | null {
  return readHeartbeatState();
}

// ── Core execution ──────────────────────────────────────────────────────────

async function executeHeartbeat(trigger: "auto" | "forced"): Promise<void> {
  if (running) return;

  const state = readHeartbeatState();
  const now = Date.now();
  const previousRunCount = state?.run_count ?? 0;
  const previousLastRun = state?.last_run ?? 0;

  running = true;
  // Mark as running with last_started, but preserve last_run from previous successful run
  writeHeartbeatState({
    last_run: previousLastRun,
    last_started: now,
    status: "running",
    run_count: previousRunCount,
  });
  log(
    "heartbeat",
    `${trigger === "forced" ? "Force-triggering" : "Triggering"} heartbeat #${previousRunCount + 1} (last run: ${previousLastRun ? new Date(previousLastRun).toISOString() : "never"})`,
  );

  const run = (async () => {
    try {
      const heartbeatLogPath = await runHeartbeatAgent(
        previousLastRun,
        previousRunCount + 1,
      );
      // Only update last_run and increment run_count on success
      writeHeartbeatState({
        last_run: Date.now(),
        last_started: now,
        status: "idle",
        run_count: previousRunCount + 1,
      });
      log(
        "heartbeat",
        `Heartbeat #${previousRunCount + 1} complete (${trigger}), log: ${heartbeatLogPath}`,
      );
    } catch (err) {
      logError(
        "heartbeat",
        `Heartbeat #${previousRunCount + 1} failed (${trigger})`,
        err,
      );
      // On failure, revert to idle but keep previous last_run and run_count
      writeHeartbeatState({
        last_run: previousLastRun,
        last_started: now,
        status: "idle",
        run_count: previousRunCount,
      });
      if (trigger === "forced") throw err;
    } finally {
      running = false;
      currentRunPromise = null;
    }
  })();

  currentRunPromise = run;
  await run;
}

// ── Heartbeat agent ─────────────────────────────────────────────────────────

async function runHeartbeatAgent(
  lastRunTimestamp: number,
  runCount: number,
): Promise<string> {
  if (!configRef) {
    throw new Error("Heartbeat agent not initialized");
  }

  const lastRunIso =
    lastRunTimestamp > 0 ? new Date(lastRunTimestamp).toISOString() : "never";

  const logsDir = dirs.logs;
  const memoryFile = pathFiles.memory;
  const workspace = configRef.workspace ?? dirs.workspace;
  const instructionsFile = resolve(workspace, "heartbeat-instructions.md");
  const dailyMemoryFile = resolve(dirs.dailyMemory, `${toYMD(new Date())}.md`);

  // Load prompt template from the prompts directory (seeded to ~/.talon/prompts/)
  const promptPath = resolve(dirs.prompts, "heartbeat.md");

  let prompt: string;
  try {
    prompt = readFileSync(promptPath, "utf-8")
      .replace(/\{\{workspace\}\}/g, workspace)
      .replace(/\{\{logsDir\}\}/g, logsDir)
      .replace(/\{\{lastRunIso\}\}/g, lastRunIso)
      .replace(/\{\{memoryFile\}\}/g, memoryFile)
      .replace(/\{\{instructionsFile\}\}/g, instructionsFile)
      .replace(/\{\{dailyMemoryFile\}\}/g, dailyMemoryFile)
      .replace(/\{\{runCount\}\}/g, String(runCount))
      .replace(/\{\{intervalMinutes\}\}/g, String(intervalMinutesRef));
  } catch {
    throw new Error(`Failed to read heartbeat prompt from ${promptPath}`);
  }

  const model =
    configRef.heartbeatModel ?? configRef.model ?? getDefaultModel();

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

  const options = {
    model,
    systemPrompt:
      "You are a background heartbeat agent for Talon. You have access to filesystem tools and all registered MCP plugins. Follow the user-defined instructions precisely. Be efficient — you have limited time.",
    cwd: workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    ...(configRef.claudeBinary
      ? { pathToClaudeCodeExecutable: configRef.claudeBinary }
      : {}),
    // Load all registered plugin MCP servers (excludes frontend-specific tools like telegram)
    mcpServers: getPluginMcpServers("", "heartbeat"),
    disallowedTools: [...DISALLOWED_TOOLS_BACKGROUND],
  };

  // NOTE: The timeout races against the agent promise but cannot abort the
  // underlying Claude subprocess (the Agent SDK does not expose an abort
  // mechanism). On timeout, we still await the agent promise to ensure the
  // running lock is not released while the subprocess is still active.
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(
      () => reject(new Error("Heartbeat agent timed out")),
      HEARTBEAT_TIMEOUT_MS,
    );
    t.unref(); // Don't prevent Node.js from exiting cleanly during shutdown
    timeoutHandle = t;
  });

  const agentPromise = (async () => {
    const qi = query({
      prompt,
      options: options as Parameters<typeof query>[0]["options"],
    });
    for await (const msg of qi) {
      await logHeartbeatMessage(heartbeatLogFile, msg);
    }
    await appendHeartbeatLog(
      heartbeatLogFile,
      `\n---\n**Heartbeat #${runCount} completed at ${new Date().toISOString()}**\n`,
    );
  })();

  try {
    await Promise.race([agentPromise, timeoutPromise]);
  } catch (err) {
    await appendHeartbeatLog(
      heartbeatLogFile,
      `\n---\n**Heartbeat #${runCount} FAILED at ${new Date().toISOString()}:** ${err}\n`,
    );
    // On timeout, wait for the agent to actually finish before releasing the lock
    // to prevent overlapping heartbeat runs
    await agentPromise.catch(() => {});
    throw err;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  return heartbeatLogFile;
}

// ── Logging helpers ─────────────────────────────────────────────────────────

let heartbeatLogFileSequence = 0;

async function createHeartbeatLogFile(): Promise<string> {
  if (!existsSync(HEARTBEAT_LOGS_DIR)) {
    await mkdir(HEARTBEAT_LOGS_DIR, { recursive: true });
  }
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-");
  const seq = heartbeatLogFileSequence++;
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

async function logHeartbeatMessage(
  logFile: string,
  msg: SDKMessage,
): Promise<void> {
  try {
    const ts = new Date().toISOString().slice(11, 19);

    switch (msg.type) {
      case "assistant": {
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
          await appendHeartbeatLog(
            logFile,
            `\n## [${ts}] Assistant\n${textBlocks.join("\n")}\n`,
          );
        }
        if (toolUseBlocks.length > 0) {
          await appendHeartbeatLog(
            logFile,
            `\n${toolUseBlocks.join("\n\n")}\n`,
          );
        }
        break;
      }
      case "result": {
        const result =
          "result" in msg
            ? (msg as { result: string }).result
            : JSON.stringify(msg);
        const truncated =
          result.length > 2000
            ? result.slice(0, 2000) + "\n... (truncated)"
            : result;
        await appendHeartbeatLog(
          logFile,
          `\n### [${ts}] Result (${msg.subtype})\n\`\`\`\n${truncated}\n\`\`\`\n`,
        );
        break;
      }
      case "system": {
        await appendHeartbeatLog(
          logFile,
          `\n### [${ts}] System (${msg.subtype})\n`,
        );
        break;
      }
      case "user": {
        if (msg.tool_use_result != null) {
          const raw =
            typeof msg.tool_use_result === "string"
              ? msg.tool_use_result
              : JSON.stringify(msg.tool_use_result, null, 2);
          const truncated =
            raw.length > 2000 ? raw.slice(0, 2000) + "\n... (truncated)" : raw;
          await appendHeartbeatLog(
            logFile,
            `\n### [${ts}] Tool Result\n\`\`\`\n${truncated}\n\`\`\`\n`,
          );
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    process.stderr.write(
      `[heartbeat] Log write error: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

// ── State helpers ────────────────────────────────────────────────────────────

function normalizeHeartbeatState(parsed: unknown): HeartbeatState | null {
  if (!parsed || typeof parsed !== "object") return null;

  const candidate = parsed as Record<string, unknown>;
  const { last_run, last_run_at, last_started, status, run_count } = candidate;

  if (typeof last_run !== "number" || !Number.isFinite(last_run)) return null;
  if (typeof run_count !== "number" || !Number.isFinite(run_count)) return null;
  if (status !== "idle" && status !== "running") return null;
  if (last_run_at !== undefined && typeof last_run_at !== "string") return null;
  if (
    last_started !== undefined &&
    (typeof last_started !== "number" || !Number.isFinite(last_started))
  ) {
    return null;
  }

  return {
    last_run,
    run_count,
    status,
    ...(last_run_at !== undefined ? { last_run_at } : {}),
    ...(last_started !== undefined ? { last_started } : {}),
  };
}

function readHeartbeatState(): HeartbeatState | null {
  try {
    if (!existsSync(HEARTBEAT_STATE_FILE)) return null;
    const raw = readFileSync(HEARTBEAT_STATE_FILE, "utf-8");
    return normalizeHeartbeatState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeHeartbeatState(state: HeartbeatState): void {
  try {
    const dir = resolve(HEARTBEAT_STATE_FILE, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const { last_run_at: _lastRunAt, ...rest } = state;
    const enriched: HeartbeatState = {
      ...rest,
      ...(state.last_run !== 0
        ? { last_run_at: new Date(state.last_run).toISOString() }
        : {}),
    };
    writeFileAtomic.sync(
      HEARTBEAT_STATE_FILE,
      JSON.stringify(enriched, null, 2) + "\n",
    );
  } catch (err) {
    logError("heartbeat", "Failed to write heartbeat state", err);
  }
}
