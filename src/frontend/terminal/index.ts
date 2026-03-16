/**
 * Terminal frontend — interactive CLI chat with Claude.
 *
 * Registers a simple action handler with the core gateway:
 * send_message → print to stdout, react → print emoji.
 * Everything else returns null (handled by gateway shared actions or skipped).
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

// ── State ───────────────────────────────────────────────────────────────────

let _activeChatId: number | null = null;
let busy = false;
let rl: ReadlineInterface | null = null;

const TERMINAL_CHAT_ID = 1;
const PROMPT = `  ${pc.green("you")}  `;

// ── Terminal output helpers ─────────────────────────────────────────────────

function clearLine(): void {
  process.stdout.write("\x1b[2K\r");
}

function output(text: string): void {
  clearLine();
  process.stdout.write(text + "\n");
}

function reprompt(): void {
  if (rl) rl.prompt();
}

// ── Spinner ─────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
let spinnerFrame = 0;

function startSpinner(): void {
  stopSpinner();
  spinnerFrame = 0;
  if (rl) rl.pause();
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    process.stdout.write(`\x1b[2K\r${pc.dim(`  ${SPINNER_FRAMES[spinnerFrame]} thinking...`)}`);
  }, 80);
}

function stopSpinner(): void {
  if (spinnerTimer) {
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    process.stdout.write("\x1b[2K\r");
  }
  if (rl) rl.resume();
}

// ── Terminal action handler ─────────────────────────────────────────────────

function createTerminalActionHandler(): (body: Record<string, unknown>, chatId: number) => Promise<ActionResult | null> {
  return async (body) => {
    const action = body.action as string;
    switch (action) {
      case "send_message": {
        stopSpinner();
        output(`\n${pc.cyan("  Talon")}  ${String(body.text ?? "")}\n`);
        incrementMessageCount();
        return { ok: true, message_id: Date.now() };
      }
      case "react": {
        stopSpinner();
        output(`\n${pc.cyan("  Talon")}  ${String(body.emoji ?? "\uD83D\uDC4D")}\n`);
        incrementMessageCount();
        return { ok: true };
      }
      case "send_message_with_buttons": {
        stopSpinner();
        const text = String(body.text ?? "");
        const rows = body.rows as Array<Array<{ text: string }>> | undefined;
        let out = `\n${pc.cyan("  Talon")}  ${text}`;
        if (rows) for (const row of rows) out += "\n  " + row.map((b) => pc.dim(`[${b.text}]`)).join("  ");
        output(out + "\n");
        incrementMessageCount();
        return { ok: true, message_id: Date.now() };
      }
      case "edit_message": case "delete_message": case "pin_message": case "unpin_message":
      case "forward_message": case "copy_message": case "send_chat_action":
        return { ok: true };
      case "get_chat_info":
        return { ok: true, id: TERMINAL_CHAT_ID, type: "private", title: "Terminal" };
      default:
        return null; // let gateway shared actions handle it
    }
  };
}

// ── Frontend interface ──────────────────────────────────────────────────────

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
    sendTyping: async () => { startSpinner(); },
    sendMessage: async (_chatId: number, text: string) => {
      stopSpinner();
      output(`\n${pc.cyan("  Talon")}  ${text}\n`);
    },
    getBridgePort: () => getGatewayPort(),

    async init() {
      setFrontendHandler(createTerminalActionHandler());
      const port = await startGateway(19877);
      log("bot", `Terminal gateway on port ${port}`);
    },

    async start() {
      console.log();
      console.log(`  ${pc.bold(pc.cyan("\uD83E\uDD85 Talon"))}  ${pc.dim("terminal mode")}`);
      console.log(`  ${pc.dim("Type a message and press Enter. Ctrl+C to quit.")}`);
      console.log(`  ${pc.dim("\u2500".repeat(50))}`);
      console.log();

      const { execute } = await import("../../core/dispatcher.js");

      rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });
      rl.prompt();

      rl.on("line", async (input) => {
        const text = input.trim();
        if (!text) { reprompt(); return; }
        if (text === "/quit" || text === "/exit") { rl!.close(); return; }

        if (text.startsWith("/model")) {
          const { getChatSettings, setChatModel, resolveModelName } = await import("../../storage/chat-settings.js");
          const { resetSession } = await import("../../storage/sessions.js");
          const arg = text.slice(7).trim();
          if (!arg) {
            output(`\n  ${pc.dim("Model:")} ${getChatSettings(String(TERMINAL_CHAT_ID)).model ?? config.model}\n`);
          } else {
            setChatModel(String(TERMINAL_CHAT_ID), resolveModelName(arg));
            resetSession(String(TERMINAL_CHAT_ID));
            output(`\n  ${pc.dim("Model set to")} ${resolveModelName(arg)}\n`);
          }
          reprompt(); return;
        }

        if (text.startsWith("/effort")) {
          const { getChatSettings, setChatEffort } = await import("../../storage/chat-settings.js");
          const arg = text.slice(8).trim();
          if (!arg) {
            output(`\n  ${pc.dim("Effort:")} ${getChatSettings(String(TERMINAL_CHAT_ID)).effort ?? "adaptive"}\n`);
          } else {
            setChatEffort(String(TERMINAL_CHAT_ID), arg === "adaptive" ? undefined : arg as "off" | "low" | "medium" | "high" | "max");
            output(`\n  ${pc.dim("Effort set to")} ${arg}\n`);
          }
          reprompt(); return;
        }

        if (text === "/status") {
          const { getSessionInfo } = await import("../../storage/sessions.js");
          const info = getSessionInfo(String(TERMINAL_CHAT_ID));
          const u = info.usage;
          const cacheHit = (u.totalInputTokens + u.totalCacheRead) > 0
            ? Math.round((u.totalCacheRead / (u.totalInputTokens + u.totalCacheRead)) * 100) : 0;
          output([
            "", `  ${pc.dim("Turns")}  ${info.turns}`, `  ${pc.dim("Cost")}   $${u.estimatedCostUsd.toFixed(4)}`,
            `  ${pc.dim("Cache")}  ${cacheHit}% hit`, `  ${pc.dim("Input")}  ${u.totalInputTokens} tokens`,
            `  ${pc.dim("Output")} ${u.totalOutputTokens} tokens`, "",
          ].join("\n"));
          reprompt(); return;
        }

        if (text === "/reset") {
          const { resetSession } = await import("../../storage/sessions.js");
          const { clearHistory } = await import("../../storage/history.js");
          resetSession(String(TERMINAL_CHAT_ID));
          clearHistory(String(TERMINAL_CHAT_ID));
          output(pc.dim("\n  Session cleared.\n"));
          reprompt(); return;
        }

        if (text === "/help") {
          output([
            "", `  ${pc.dim("/model")}    Show or change model`, `  ${pc.dim("/effort")}   Set thinking effort`,
            `  ${pc.dim("/status")}   Session stats`, `  ${pc.dim("/reset")}    Clear session`, `  ${pc.dim("/quit")}     Exit`, "",
          ].join("\n"));
          reprompt(); return;
        }

        // Reset message count for this turn
        // (gateway tracks via incrementMessageCount)

        try {
          const result = await execute({
            chatId: String(TERMINAL_CHAT_ID), numericChatId: TERMINAL_CHAT_ID,
            prompt: text, senderName: "User", isGroup: false, source: "message",
          });
          stopSpinner();
          if (getGatewayMessageCount() === 0 && result.text && result.text.length > 20) {
            output(`\n${pc.cyan("  Talon")}  ${result.text}\n`);
          }
          reprompt();
        } catch (err) {
          stopSpinner();
          output(`\n  ${pc.red("Error:")} ${err instanceof Error ? err.message : err}\n`);
          reprompt();
        }
      });

      rl.on("close", () => { console.log(`\n  ${pc.dim("Goodbye!")}\n`); process.exit(0); });
      await new Promise(() => {});
    },

    async stop() { await stopGateway(); },
  };
}
