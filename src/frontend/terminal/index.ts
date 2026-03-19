/**
 * Terminal frontend — interactive CLI chat with Claude.
 *
 * Features:
 *   - Color-coded messages with left-border styling
 *   - Tool call visibility (name, params, status)
 *   - Streaming phase indicator (thinking / responding / tool use)
 *   - Session stats in header
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import pc from "picocolors";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager, ActionResult } from "../../core/types.js";
import {
  startGateway,
  stopGateway,
  setGatewayContext,
  clearGatewayContext,
  getGatewayMessageCount,
  getGatewayPort,
  setFrontendHandler,
  incrementMessageCount,
} from "../../core/gateway.js";
import { log } from "../../util/log.js";

// ── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_CHAT_ID = 1;
const COLS = Math.min(process.stdout.columns || 100, 120);
const BAR = pc.dim("│");
const HLINE = pc.dim("─".repeat(COLS - 2));

// ── State ────────────────────────────────────────────────────────────────────

let _activeChatId: number | null = null;
let busy = false;
let rl: ReadlineInterface | null = null;
let currentPhase: "idle" | "thinking" | "tool" | "text" = "idle";
let toolCallCount = 0;

// ── Output helpers ───────────────────────────────────────────────────────────

function clearLine(): void {
  process.stdout.write("\x1b[2K\r");
}

function write(text: string): void {
  clearLine();
  process.stdout.write(text);
}

function writeln(text = ""): void {
  clearLine();
  process.stdout.write(text + "\n");
}

function reprompt(): void {
  if (rl) {
    process.stdout.write("\n");
    rl.prompt();
  }
}

/** Word-wrap text to fit terminal width, preserving existing newlines. */
function wrap(text: string, indent: number, maxWidth: number): string {
  const width = maxWidth - indent;
  if (width <= 20) return text;
  const pad = " ".repeat(indent);
  return text.split("\n").map((line) => {
    if (line.length <= width) return pad + line;
    const words = line.split(" ");
    const wrapped: string[] = [];
    let current = "";
    for (const word of words) {
      if (current.length + word.length + 1 > width && current) {
        wrapped.push(pad + current);
        current = word;
      } else {
        current = current ? current + " " + word : word;
      }
    }
    if (current) wrapped.push(pad + current);
    return wrapped.join("\n");
  }).join("\n");
}

// ── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;
let spinnerLabel = "thinking";

function startSpinner(label = "thinking"): void {
  stopSpinner();
  spinnerLabel = label;
  spinnerFrame = 0;
  if (rl) rl.pause();
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
    write(pc.dim(`  ${SPINNER[spinnerFrame]} ${spinnerLabel}...`));
  }, 80);
}

function updateSpinnerLabel(label: string): void {
  spinnerLabel = label;
}

function stopSpinner(): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    clearLine();
  }
  if (rl) rl.resume();
}

// ── Message rendering ────────────────────────────────────────────────────────

function renderUserMessage(text: string): void {
  writeln();
  writeln(`  ${pc.green("▍")} ${pc.bold(pc.green("You"))}`);
  const wrapped = wrap(text, 4, COLS);
  for (const line of wrapped.split("\n")) {
    writeln(`  ${pc.green("▍")} ${line.trimStart()}`);
  }
}

function renderAssistantMessage(text: string): void {
  writeln();
  writeln(`  ${pc.cyan("▍")} ${pc.bold(pc.cyan("Talon"))}`);
  const wrapped = wrap(text, 4, COLS);
  for (const line of wrapped.split("\n")) {
    writeln(`  ${pc.cyan("▍")} ${line.trimStart()}`);
  }
}

function renderToolCall(toolName: string, input: Record<string, unknown>): void {
  toolCallCount++;

  // Strip MCP server prefix: "mcp__npuw-tools__jenkins_list_builds" → "jenkins_list_builds"
  let cleanName = toolName;
  if (cleanName.startsWith("mcp__")) {
    const parts = cleanName.split("__");
    cleanName = parts[parts.length - 1];
  }

  // Format tool name for display
  const displayName = cleanName.replace(/_/g, " ");

  // Extract the most meaningful parameter to show
  let detail = "";
  const maxDetail = COLS - displayName.length - 12;

  // Claude Code built-in tools
  if (input.command) {
    // Bash: show the command being run
    const cmd = String(input.command);
    detail = cmd.length > maxDetail ? cmd.slice(0, maxDetail - 3) + "..." : cmd;
  } else if (input.file_path) {
    // Read/Write/Edit: show file path
    detail = String(input.file_path);
  } else if (input.pattern && input.path) {
    // Grep/Glob: show pattern + path
    detail = `${input.pattern} in ${input.path}`;
  } else if (input.pattern) {
    detail = String(input.pattern);
  }
  // NPUW plugin tools
  else if (input.action) detail = String(input.action);
  else if (input.query) detail = String(input.query).slice(0, maxDetail);
  else if (input.url) detail = String(input.url).slice(0, maxDetail);
  else if (input.type) detail = String(input.type);
  else if (input.name) detail = String(input.name);
  else if (input.model) detail = String(input.model);
  else if (input.package_url) detail = String(input.package_url);
  else if (input.build_number) detail = `#${input.build_number}`;
  else if (input.packages) detail = (input.packages as string[]).join(", ");
  // Fallback: show first string param
  else {
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === "string" && v.length > 0 && k !== "_chatId") {
        detail = `${k}=${v.length > 50 ? v.slice(0, 50) + "..." : v}`;
        break;
      }
    }
  }

  const detailStr = detail ? ` ${pc.dim(detail)}` : "";
  writeln(`  ${pc.yellow("▍")} ${pc.dim("└")} ${pc.yellow(displayName)}${detailStr}`);
}

function renderToolResult(text: string): void {
  // Show a compact version of tool results
  const lines = text.split("\n").filter((l) => l.trim());
  const preview = lines.slice(0, 3).map((l) => l.slice(0, COLS - 10));
  for (const line of preview) {
    writeln(`  ${pc.yellow("▍")}   ${pc.dim(line)}`);
  }
  if (lines.length > 3) {
    writeln(`  ${pc.yellow("▍")}   ${pc.dim(`... ${lines.length - 3} more lines`)}`);
  }
}

function renderSystemMessage(text: string): void {
  writeln(`  ${pc.dim("▍")} ${pc.dim(text)}`);
}

function renderError(text: string): void {
  writeln();
  writeln(`  ${pc.red("▍")} ${pc.red("Error")}: ${text}`);
}

function renderStats(durationMs: number, inputTokens: number, outputTokens: number, cacheRead: number, tools: number): void {
  const dur = (durationMs / 1000).toFixed(1);
  const cacheHit = (inputTokens + cacheRead) > 0 ? Math.round((cacheRead / (inputTokens + cacheRead)) * 100) : 0;
  const parts = [
    `${dur}s`,
    `${inputTokens + outputTokens} tokens`,
    `${cacheHit}% cache`,
  ];
  if (tools > 0) parts.push(`${tools} tool${tools > 1 ? "s" : ""}`);
  writeln(`  ${pc.dim("▍")} ${pc.dim(parts.join("  ·  "))}`);
}

// ── Terminal action handler ──────────────────────────────────────────────────

function createTerminalActionHandler(): (body: Record<string, unknown>, chatId: number) => Promise<ActionResult | null> {
  return async (body) => {
    const action = body.action as string;
    switch (action) {
      case "send_message": {
        stopSpinner();
        renderAssistantMessage(String(body.text ?? ""));
        incrementMessageCount();
        return { ok: true, message_id: Date.now() };
      }
      case "react": {
        stopSpinner();
        writeln(`  ${pc.cyan("▍")} ${String(body.emoji ?? "👍")}`);
        incrementMessageCount();
        return { ok: true };
      }
      case "send_message_with_buttons": {
        stopSpinner();
        const text = String(body.text ?? "");
        const rows = body.rows as Array<Array<{ text: string }>> | undefined;
        renderAssistantMessage(text);
        if (rows) {
          for (const row of rows) {
            writeln(`  ${pc.cyan("▍")}   ${row.map((b) => pc.dim(`[${b.text}]`)).join("  ")}`);
          }
        }
        incrementMessageCount();
        return { ok: true, message_id: Date.now() };
      }
      case "edit_message": case "delete_message": case "pin_message": case "unpin_message":
      case "forward_message": case "copy_message": case "send_chat_action":
        return { ok: true };
      case "get_chat_info":
        return { ok: true, id: TERMINAL_CHAT_ID, type: "private", title: "Terminal" };
      default:
        return null;
    }
  };
}

// ── Frontend interface ───────────────────────────────────────────────────────

export type TerminalFrontend = {
  context: ContextManager;
  sendTyping: (chatId: number) => Promise<void>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  getBridgePort: () => number;
  init: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createTerminalFrontend(config: TalonConfig): TerminalFrontend {
  const context: ContextManager = {
    acquire: () => { _activeChatId = TERMINAL_CHAT_ID; busy = true; setGatewayContext(TERMINAL_CHAT_ID); },
    release: () => { _activeChatId = null; busy = false; clearGatewayContext(TERMINAL_CHAT_ID); },
    isBusy: () => busy,
    getMessageCount: () => getGatewayMessageCount(),
  };

  return {
    context,
    sendTyping: async () => { startSpinner(currentPhase === "tool" ? "using tools" : "thinking"); },
    sendMessage: async (_chatId: number, text: string) => {
      stopSpinner();
      renderAssistantMessage(text);
    },
    getBridgePort: () => getGatewayPort(),

    async init() {
      setFrontendHandler(createTerminalActionHandler());
      const port = await startGateway(19877);
      log("bot", `Terminal gateway on port ${port}`);
    },

    async start() {
      // "claude-opus-4-6" → "Opus 4.6", "claude-sonnet-4-6" → "Sonnet 4.6"
      const model = config.model
        .replace("claude-", "")
        .replace(/^(\w+)-(\d+)-(\d+)/, (_, name, maj, min) => `${name.charAt(0).toUpperCase() + name.slice(1)} ${maj}.${min}`);
      writeln();
      writeln(`  ${pc.bold(pc.cyan("Talon"))} ${pc.dim("·")} ${pc.dim(model)}`);
      writeln(`  ${HLINE}`);
      writeln(`  ${pc.dim("Type a message. /help for commands. Ctrl+C to quit.")}`);

      const { execute } = await import("../../core/dispatcher.js");

      const prompt = `  ${pc.green(">")} `;
      rl = createInterface({ input: process.stdin, output: process.stdout, prompt });
      rl.prompt();

      rl.on("line", async (input) => {
        const text = input.trim();
        if (!text) { reprompt(); return; }
        if (text === "/quit" || text === "/exit") { rl!.close(); return; }

        // ── Slash commands ──
        if (text.startsWith("/model")) {
          const { getChatSettings, setChatModel, resolveModelName } = await import("../../storage/chat-settings.js");
          const { resetSession } = await import("../../storage/sessions.js");
          const arg = text.slice(7).trim();
          if (!arg) {
            renderSystemMessage(`Model: ${getChatSettings(String(TERMINAL_CHAT_ID)).model ?? config.model}`);
          } else {
            setChatModel(String(TERMINAL_CHAT_ID), resolveModelName(arg));
            resetSession(String(TERMINAL_CHAT_ID));
            renderSystemMessage(`Model set to ${resolveModelName(arg)}`);
          }
          reprompt(); return;
        }

        if (text.startsWith("/effort")) {
          const { getChatSettings, setChatEffort } = await import("../../storage/chat-settings.js");
          const arg = text.slice(8).trim();
          if (!arg) {
            renderSystemMessage(`Effort: ${getChatSettings(String(TERMINAL_CHAT_ID)).effort ?? "adaptive"}`);
          } else {
            setChatEffort(String(TERMINAL_CHAT_ID), arg === "adaptive" ? undefined : arg as "off" | "low" | "medium" | "high" | "max");
            renderSystemMessage(`Effort set to ${arg}`);
          }
          reprompt(); return;
        }

        if (text === "/status") {
          const { getSessionInfo } = await import("../../storage/sessions.js");
          const info = getSessionInfo(String(TERMINAL_CHAT_ID));
          const u = info.usage;
          const cacheHit = (u.totalInputTokens + u.totalCacheRead) > 0
            ? Math.round((u.totalCacheRead / (u.totalInputTokens + u.totalCacheRead)) * 100) : 0;
          writeln();
          writeln(`  ${pc.dim("▍")} ${pc.bold("Session Stats")}`);
          writeln(`  ${pc.dim("▍")}   Turns:   ${info.turns}`);
          writeln(`  ${pc.dim("▍")}   Cost:    $${u.estimatedCostUsd.toFixed(4)}`);
          writeln(`  ${pc.dim("▍")}   Cache:   ${cacheHit}% hit`);
          writeln(`  ${pc.dim("▍")}   Input:   ${u.totalInputTokens.toLocaleString()} tokens`);
          writeln(`  ${pc.dim("▍")}   Output:  ${u.totalOutputTokens.toLocaleString()} tokens`);
          reprompt(); return;
        }

        if (text === "/reset") {
          const { resetSession } = await import("../../storage/sessions.js");
          const { clearHistory } = await import("../../storage/history.js");
          resetSession(String(TERMINAL_CHAT_ID));
          clearHistory(String(TERMINAL_CHAT_ID));
          renderSystemMessage("Session cleared.");
          reprompt(); return;
        }

        if (text === "/help") {
          writeln();
          writeln(`  ${pc.dim("▍")} ${pc.bold("Commands")}`);
          writeln(`  ${pc.dim("▍")}   ${pc.cyan("/model")} [name]   Show or change model (opus, sonnet, haiku)`);
          writeln(`  ${pc.dim("▍")}   ${pc.cyan("/effort")} [lvl]   Set thinking effort (off/low/medium/high/max)`);
          writeln(`  ${pc.dim("▍")}   ${pc.cyan("/status")}         Session stats (tokens, cost, cache)`);
          writeln(`  ${pc.dim("▍")}   ${pc.cyan("/reset")}          Clear session and history`);
          writeln(`  ${pc.dim("▍")}   ${pc.cyan("/quit")}           Exit`);
          reprompt(); return;
        }

        // ── Execute query ──
        // (readline already echoed the input, no need to repeat it)
        toolCallCount = 0;
        currentPhase = "thinking";
        startSpinner("thinking");

        try {
          const result = await execute({
            chatId: String(TERMINAL_CHAT_ID),
            numericChatId: TERMINAL_CHAT_ID,
            prompt: text,
            senderName: "User",
            isGroup: false,
            source: "message",
            onStreamDelta: (_accumulated, phase) => {
              if (phase === "thinking" && currentPhase !== "thinking") {
                currentPhase = "thinking";
                updateSpinnerLabel("thinking");
              } else if (phase === "text" && currentPhase !== "text") {
                currentPhase = "text";
                updateSpinnerLabel("responding");
              }
            },
            onToolUse: (toolName, input) => {
              stopSpinner();
              currentPhase = "tool";
              renderToolCall(toolName, input);
              startSpinner("using tools");
            },
            onTextBlock: async (blockText) => {
              stopSpinner();
              renderAssistantMessage(blockText);
            },
          });

          stopSpinner();
          currentPhase = "idle";

          // Show final response if not already sent via onTextBlock/action handler
          if (getGatewayMessageCount() === 0 && result.text?.trim()) {
            renderAssistantMessage(result.text);
          }

          // Show execution stats
          renderStats(result.durationMs, result.inputTokens, result.outputTokens, result.cacheRead, toolCallCount);

          reprompt();
        } catch (err) {
          stopSpinner();
          currentPhase = "idle";
          renderError(err instanceof Error ? err.message : String(err));
          reprompt();
        }
      });

      rl.on("close", () => {
        writeln();
        writeln(`  ${pc.dim("Goodbye!")}`);
        writeln();
        process.exit(0);
      });

      await new Promise(() => {});
    },

    async stop() { await stopGateway(); },
  };
}
