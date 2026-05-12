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
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
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
import {
  buildMcpServers,
  getActiveFrontends,
} from "../backend/claude-sdk/index.js";

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
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute soft cap
const DEFAULT_HEARTBEAT_ABORT_GRACE_MS = 30 * 1000;
const DEFAULT_SUBPROCESS_KILL_GRACE_MS = 5 * 1000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Overridable via env (eg integration tests). Falls back to 10 min. */
const HEARTBEAT_TIMEOUT_MS = envMs(
  "TALON_HEARTBEAT_TIMEOUT_MS",
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
);
/**
 * After we abort the SDK on timeout, wait this long for the agent promise to
 * settle gracefully. If it still hasn't settled we release the lock anyway
 * (so the next heartbeat can fire) and trigger a subprocess sweep.
 */
const HEARTBEAT_ABORT_GRACE_MS = envMs(
  "TALON_HEARTBEAT_ABORT_GRACE_MS",
  DEFAULT_HEARTBEAT_ABORT_GRACE_MS,
);
/** SIGTERM → grace → SIGKILL window when force-killing orphan subprocesses. */
const SUBPROCESS_KILL_GRACE_MS = envMs(
  "TALON_HEARTBEAT_SUBPROCESS_KILL_GRACE_MS",
  DEFAULT_SUBPROCESS_KILL_GRACE_MS,
);
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

/**
 * Build the heartbeat agent system prompt. Adapts to whatever non-terminal
 * frontends are currently configured — names each `${frontend}-tools` MCP
 * server it actually has access to, instead of hard-coding "telegram-tools".
 *
 * Terminal-only deployments get a minimal prompt (no outbound section, since
 * there's no chat to message). Multi-frontend deployments get a list of every
 * `${frontend}-tools` server available.
 *
 * Exported for tests.
 */
export function buildHeartbeatSystemPrompt(): string {
  const base = [
    "You are a background heartbeat agent for Talon. You have access to",
    "filesystem tools and all registered MCP plugins. Follow the",
    "user-defined instructions precisely. Be efficient — you have limited time.",
  ];

  let frontends: readonly string[];
  try {
    frontends = getActiveFrontends();
  } catch {
    // Agent config not initialised (test paths) — no outbound surface.
    frontends = [];
  }

  if (frontends.length === 0) {
    return base.join("\n");
  }

  const toolList = frontends.map((f) => `\`${f}-tools\``).join(", ");
  const exampleFrontend = frontends[0];
  const outbound = [
    "",
    `OUTBOUND MESSAGING: You also have access to the frontend tool servers — ${toolList} — which expose \`send\`, \`react\`, and the rest of the messaging surface. Because there is NO ambient chat in heartbeat mode, every outbound tool call MUST include an explicit \`chat_id\` parameter. The bridge promotes that chat_id to the routing target, so \`send(type="text", text="...", chat_id=N)\` from \`${exampleFrontend}-tools\` delivers a message to chat N on that frontend. Known chat IDs live in your memory.md (per-frontend — for Telegram, Dylan's DM ID and group IDs are recorded; other frontends list their own). Without \`chat_id\`, the gateway returns 'No active chat context and no explicit numeric chat_id'.`,
    "",
    "Use outbound messaging sparingly — proactive pings should be",
    "high-signal (e.g. 'PR ready, link: ...') and not status spam.",
  ];

  return [...base, ...outbound].join("\n");
}

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

  // AbortController is the SDK's canonical way to signal a cancellation. When
  // .abort() is called the SDK should tear down its subprocess and the query()
  // async iterator should throw. We still defend against the case where it
  // doesn't — see HEARTBEAT_ABORT_GRACE_MS below.
  const abortController = new AbortController();

  const options = {
    model,
    systemPrompt: buildHeartbeatSystemPrompt(),
    cwd: workspace,
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true,
    abortController,
    ...(configRef.claudeBinary
      ? { pathToClaudeCodeExecutable: configRef.claudeBinary }
      : {}),
    // Load plugin MCP servers + frontend-tools so the heartbeat can send
    // messages, react, and read chat history with an explicit `chat_id`.
    // The frontend MCP server is spawned with TALON_CHAT_ID="heartbeat" —
    // a sentinel string telling the bridge there's no ambient chat, so
    // every outbound tool call MUST include `chat_id` in its params.
    //
    // `buildMcpServers` throws if the agent config hasn't been initialised
    // (e.g. tests that mock the agent). Treat that case as "no frontend
    // MCP available" rather than crashing the whole heartbeat — the
    // plugin MCP servers still load and the agent runs normally.
    mcpServers: {
      ...(() => {
        try {
          return buildMcpServers("heartbeat");
        } catch {
          return {};
        }
      })(),
      ...getPluginMcpServers("", "heartbeat"),
    },
    disallowedTools: [...DISALLOWED_TOOLS_BACKGROUND],
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
      reject(new Error("Heartbeat agent timed out"));
    }, HEARTBEAT_TIMEOUT_MS);
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
    // Snapshot timeout state and clear the timer immediately, BEFORE any
    // awaits in the error-handling path. Otherwise the timer can fire during
    // the async log append below and flip `timeoutFired` to true for what
    // was actually a non-timeout failure — causing a spurious abort + orphan
    // sweep on every late-stage agent rejection. (Copilot review on #144.)
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
      // Give the SDK a bounded grace window to clean up its subprocess after
      // the abort signal — but never wait indefinitely. If the SDK ignores
      // the abort (this has happened in prod), release the lock anyway and
      // launch an orphan-subprocess sweep in the background.
      const settled = await raceWithTimeout(
        agentPromise.catch(() => "settled"),
        HEARTBEAT_ABORT_GRACE_MS,
      );
      if (settled === "timed_out") {
        logWarn(
          "heartbeat",
          `Heartbeat #${runCount} SDK ignored abort after ${HEARTBEAT_ABORT_GRACE_MS}ms — releasing lock and evicting orphan subprocesses`,
        );
        // Fire-and-forget — we don't block the next heartbeat on subprocess
        // cleanup. Any errors are logged inside the sweep itself.
        evictOrphanHeartbeatSubprocesses().catch((sweepErr) => {
          logError("heartbeat", "Orphan subprocess sweep failed", sweepErr);
        });
      }
    } else {
      // Non-timeout failure path — agentPromise has already rejected/resolved.
      // No need to wait.
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

// ── Eviction helpers ─────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Returns the promise's resolved value, or
 * the sentinel `"timed_out"` if the timeout fires first.
 *
 * NOTE: if `p` rejects before the timeout fires, that rejection propagates —
 * callers that need a never-throwing race should `.catch()` the input promise
 * themselves (as the heartbeat eviction path does with
 * `agentPromise.catch(() => "settled")`).
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

/**
 * Find and kill any lingering `claude` subprocess (and its descendants) whose
 * environment carries `TALON_CHAT_ID=heartbeat`. We identify them by reading
 * /proc/<pid>/environ — that file is owned by the same uid as the spawner
 * (us) and contains the env vars Talon set when launching the SDK subprocess
 * via MCP launcher. SIGTERM with a short grace, then SIGKILL.
 *
 * Exported for tests; do not call from non-eviction code paths.
 */
export async function evictOrphanHeartbeatSubprocesses(): Promise<{
  found: number;
  termed: number;
  killed: number;
}> {
  const result = { found: 0, termed: 0, killed: 0 };

  if (process.platform !== "linux") {
    // /proc is Linux-only. macOS/Windows: rely on SDK abort + grace alone.
    return result;
  }

  const myPid = process.pid;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return result;
  }

  const matched: number[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === myPid) continue;
    try {
      const environRaw = await readFile(`/proc/${pid}/environ`, "utf-8");
      // /proc/<pid>/environ is NUL-delimited. Split on \0 and match exact
      // entries — a raw .includes() can false-positive on other vars whose
      // value happens to contain the substring. Since this code can SIGKILL,
      // err on the side of strict matching. (Copilot review on #144.)
      const envEntries = environRaw.split("\0");
      if (envEntries.includes("TALON_CHAT_ID=heartbeat")) {
        matched.push(pid);
      }
    } catch {
      // Process exited between readdir and readFile, or we don't own it. Skip.
      continue;
    }
  }

  result.found = matched.length;
  if (matched.length === 0) return result;

  // SIGTERM all matched pids.
  for (const pid of matched) {
    try {
      process.kill(pid, "SIGTERM");
      result.termed++;
    } catch {
      // ESRCH (already gone) or EPERM — ignore.
    }
  }

  // Grace, then SIGKILL anything that hasn't exited.
  await new Promise<void>((r) => {
    const t = setTimeout(r, SUBPROCESS_KILL_GRACE_MS);
    t.unref();
  });

  for (const pid of matched) {
    try {
      // process.kill with signal 0 just probes — throws ESRCH if gone.
      process.kill(pid, 0);
      // Still alive — escalate.
      process.kill(pid, "SIGKILL");
      result.killed++;
    } catch {
      // Already gone — no-op.
    }
  }

  log(
    "heartbeat",
    `Subprocess sweep: found=${result.found} termed=${result.termed} killed=${result.killed}`,
  );
  return result;
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
