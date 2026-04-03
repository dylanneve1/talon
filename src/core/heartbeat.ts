/**
 * Heartbeat — background autonomous maintenance agent.
 *
 * Runs every hour (configurable) to perform system maintenance,
 * review activity, and proactively reach out to relevant people.
 *
 * Unlike Dream (filesystem-only), Heartbeat has full access to Telegram
 * tools via its own MCP server — it can message people, check chats, etc.
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import writeFileAtomic from "write-file-atomic";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { files as pathFiles, dirs } from "../util/paths.js";
import { log, logError, logWarn } from "../util/log.js";
import type { TalonConfig } from "../util/config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type HeartbeatState = {
  /** Unix millisecond timestamp of the last completed heartbeat run. */
  lastRun: number;
  /** Human-readable ISO timestamp of the last completed heartbeat run. */
  lastRunAt?: string;
  /** "idle" when no heartbeat is running, "running" while one is active. */
  status: "idle" | "running";
  /** Brief summary of what the last heartbeat accomplished. */
  lastSummary?: string;
  /** Total number of completed heartbeat runs. */
  runCount: number;
};

// ── Constants ────────────────────────────────────────────────────────────────

const HEARTBEAT_STATE_FILE = pathFiles.heartbeatState;
const HEARTBEAT_LOG_DIR = resolve(dirs.logs, "heartbeats");
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10-minute max
const HEARTBEAT_CHAT_ID = "heartbeat";

// ── State ────────────────────────────────────────────────────────────────────

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let configRef: TalonConfig | null = null;
let gatewayPortFn: (() => number) | null = null;
let gatewaySetContext: ((chatId: number, stringId?: string) => void) | null = null;
let gatewayClearContext: ((chatId?: number | string) => void) | null = null;

// ── Init ─────────────────────────────────────────────────────────────────────

export function initHeartbeat(
  config: TalonConfig,
  getPort: () => number,
  setContext: (chatId: number, stringId?: string) => void,
  clearContext: (chatId?: number | string) => void,
): void {
  configRef = config;
  gatewayPortFn = getPort;
  gatewaySetContext = setContext;
  gatewayClearContext = clearContext;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function startHeartbeatTimer(intervalMs: number = 3_600_000): void {
  if (timer || startupTimer) return;
  const minutes = Math.round(intervalMs / 60_000);
  log("heartbeat", `Started: running every ${minutes}m (first run in 5m)`);

  // Run first heartbeat after 5 minutes (let system stabilize)
  startupTimer = setTimeout(() => {
    startupTimer = null;
    executeHeartbeat().catch((err) =>
      logError("heartbeat", "Heartbeat failed", err),
    );
    timer = setInterval(() => {
      executeHeartbeat().catch((err) =>
        logError("heartbeat", "Heartbeat failed", err),
      );
    }, intervalMs);
  }, 5 * 60 * 1000);
}

export function stopHeartbeatTimer(): void {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Force a heartbeat run immediately, regardless of schedule.
 * Throws if a heartbeat is already running.
 */
export async function forceHeartbeat(): Promise<void> {
  if (running) throw new Error("Heartbeat already running");
  return executeHeartbeat();
}

/** Get the current heartbeat state for status display. */
export function getHeartbeatStatus(): HeartbeatState {
  return readState();
}

// ── Core execution ──────────────────────────────────────────────────────────

async function executeHeartbeat(): Promise<void> {
  if (running) return;
  if (!configRef) {
    logWarn("heartbeat", "Heartbeat not initialized — skipping");
    return;
  }
  running = true;

  const state = readState();
  state.status = "running";
  writeState(state);

  const startTime = Date.now();
  const logFile = createHeartbeatLogFile();

  // Acquire gateway context so heartbeat MCP tools can route actions
  const HEARTBEAT_NUMERIC_ID = 0;
  gatewaySetContext?.(HEARTBEAT_NUMERIC_ID, HEARTBEAT_CHAT_ID);

  try {
    // Load heartbeat prompt
    const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const promptPath = resolve(projectRoot, "prompts/heartbeat.md");

    let prompt: string;
    try {
      prompt = readFileSync(promptPath, "utf-8")
        .replace(/\{\{workspace\}\}/g, configRef.workspace)
        .replace(/\{\{notesDir\}\}/g, resolve(configRef.workspace, "notes"))
        .replace(/\{\{memoryFile\}\}/g, pathFiles.memory)
        .replace(/\{\{logsDir\}\}/g, dirs.logs)
        .replace(/\{\{uploadsDir\}\}/g, dirs.uploads)
        .replace(/\{\{stickersDir\}\}/g, dirs.stickers)
        .replace(/\{\{lastRunIso\}\}/g, state.lastRunAt ?? "never")
        .replace(/\{\{now\}\}/g, new Date().toISOString())
        .replace(/\{\{runCount\}\}/g, String(state.runCount));
    } catch {
      throw new Error(`Failed to read heartbeat prompt from ${promptPath}`);
    }

    // Build MCP server config — include telegram-tools so heartbeat can message people
    const bridgeUrl = `http://127.0.0.1:${gatewayPortFn!()}`;
    const tsxImport = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../node_modules/tsx/dist/esm/index.mjs",
    );

    const model = configRef.heartbeatModel ?? configRef.dreamModel ?? configRef.model;

    const systemPrompt = [
      "You are Talon's autonomous heartbeat agent. You run periodically to maintain the system,",
      "review activity, and proactively reach out to relevant people.",
      "",
      "You have access to Telegram tools. You CAN send messages to users using send_to_chat or message_user.",
      "You CAN read any chat, check unread counts, review notes, and manage files.",
      "",
      "Rules:",
      "- Do at least ONE tangible thing each heartbeat",
      "- Be concise in your work — don't over-explain",
      "- Log a summary of what you did",
      "- Only message people if there's a genuine reason (don't spam)",
      "- Check memory/notes for pending items, follow-ups, or reminders",
    ].join("\n");

    appendHeartbeatLog(logFile, `# Heartbeat ${new Date().toISOString()}\n`);
    appendHeartbeatLog(logFile, `**Model:** ${model}\n`);
    appendHeartbeatLog(logFile, `**Prompt:**\n\`\`\`\n${prompt}\n\`\`\`\n\n---\n`);

    const options = {
      model,
      systemPrompt,
      cwd: configRef.workspace,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      ...(configRef.claudeBinary
        ? { pathToClaudeCodeExecutable: configRef.claudeBinary }
        : {}),
      mcpServers: {
        "telegram-tools": {
          command: "node",
          args: [
            "--import", tsxImport,
            resolve(dirname(fileURLToPath(import.meta.url)), "../backend/claude-sdk/tools/index.ts"),
          ],
          env: {
            TALON_BRIDGE_URL: bridgeUrl,
            TALON_CHAT_ID: HEARTBEAT_CHAT_ID,
            TALON_FRONTEND_MODE: "userbot",
          },
        },
      },
      disallowedTools: [
        "Agent",
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
      ],
    };

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Heartbeat agent timed out")), HEARTBEAT_TIMEOUT_MS),
    );

    let output = "";

    const agentPromise = (async () => {
      const qi = query({
        prompt,
        options: options as Parameters<typeof query>[0]["options"],
      });
      for await (const msg of qi) {
        const text = logHeartbeatMessage(logFile, msg);
        if (text) output += text;
      }
      appendHeartbeatLog(logFile, `\n---\n**Heartbeat completed at ${new Date().toISOString()}**\n`);
    })();

    try {
      await Promise.race([agentPromise, timeoutPromise]);
    } catch (err) {
      appendHeartbeatLog(logFile, `\n---\n**Heartbeat FAILED at ${new Date().toISOString()}:** ${err}\n`);
      throw err;
    }

    state.lastRun = Date.now();
    state.lastRunAt = new Date().toISOString();
    state.status = "idle";
    state.lastSummary = output.slice(0, 500);
    state.runCount++;
    writeState(state);

    const elapsed = Date.now() - startTime;
    const elapsedStr = elapsed < 60_000
      ? `${Math.round(elapsed / 1000)}s`
      : `${Math.round(elapsed / 60_000)}m`;
    log("heartbeat", `Complete in ${elapsedStr}: ${state.lastSummary?.slice(0, 100) ?? "no summary"}`);
  } catch (err) {
    logError("heartbeat", "Heartbeat execution failed", err);
    state.status = "idle";
    writeState(state);
  } finally {
    running = false;
    gatewayClearContext?.(HEARTBEAT_NUMERIC_ID);
  }
}

// ── Logging helpers ─────────────────────────────────────────────────────────

function createHeartbeatLogFile(): string {
  if (!existsSync(HEARTBEAT_LOG_DIR)) {
    mkdirSync(HEARTBEAT_LOG_DIR, { recursive: true });
  }
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return resolve(HEARTBEAT_LOG_DIR, `heartbeat-${ts}.md`);
}

function appendHeartbeatLog(logFile: string, text: string): void {
  try {
    appendFileSync(logFile, text);
  } catch (err) {
    logError("heartbeat", "Failed to write heartbeat log", err);
  }
}

/** Log a message from the heartbeat agent, return assistant text if any. */
function logHeartbeatMessage(logFile: string, msg: SDKMessage): string | null {
  try {
    const ts = new Date().toISOString().slice(11, 19);

    switch (msg.type) {
      case "assistant": {
        const textBlocks = msg.message.content
          .filter((b) => b.type === "text")
          .map((b) => "text" in b ? (b as { text: string }).text : "");
        const toolUseBlocks = msg.message.content
          .filter((b) => b.type === "tool_use")
          .map((b) => {
            const tu = b as { name: string; input: unknown };
            return `**Tool call:** \`${tu.name}\`\n\`\`\`json\n${JSON.stringify(tu.input, null, 2)}\n\`\`\``;
          });

        let assistantText: string | null = null;
        if (textBlocks.length > 0) {
          assistantText = textBlocks.join("\n");
          appendHeartbeatLog(logFile, `\n## [${ts}] Assistant\n${assistantText}\n`);
        }
        if (toolUseBlocks.length > 0) {
          appendHeartbeatLog(logFile, `\n${toolUseBlocks.join("\n\n")}\n`);
        }
        return assistantText;
      }
      case "result": {
        const result = "result" in msg ? (msg as { result: string }).result : JSON.stringify(msg);
        const truncated = result.length > 2000 ? result.slice(0, 2000) + "\n... (truncated)" : result;
        appendHeartbeatLog(logFile, `\n### [${ts}] Result (${msg.subtype})\n\`\`\`\n${truncated}\n\`\`\`\n`);
        break;
      }
      case "system": {
        appendHeartbeatLog(logFile, `\n### [${ts}] System (${msg.subtype})\n`);
        break;
      }
      case "user": {
        if (msg.tool_use_result != null) {
          const raw = typeof msg.tool_use_result === "string"
            ? msg.tool_use_result
            : JSON.stringify(msg.tool_use_result, null, 2);
          const truncated = raw.length > 2000 ? raw.slice(0, 2000) + "\n... (truncated)" : raw;
          appendHeartbeatLog(logFile, `\n### [${ts}] Tool Result\n\`\`\`\n${truncated}\n\`\`\`\n`);
        }
        break;
      }
      default:
        break;
    }
  } catch {
    // Don't let logging errors break the heartbeat
  }
  return null;
}

// ── State helpers ────────────────────────────────────────────────────────────

function readState(): HeartbeatState {
  try {
    if (existsSync(HEARTBEAT_STATE_FILE)) {
      const raw = readFileSync(HEARTBEAT_STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as HeartbeatState;
      if (typeof parsed.lastRun === "number") return parsed;
    }
  } catch { /* corrupt or missing — return defaults */ }
  return { lastRun: 0, status: "idle", runCount: 0 };
}

function writeState(state: HeartbeatState): void {
  try {
    const dir = resolve(HEARTBEAT_STATE_FILE, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomic.sync(HEARTBEAT_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  } catch (err) {
    logError("heartbeat", "Failed to write heartbeat state", err);
  }
}
