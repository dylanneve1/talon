/**
 * Terminal frontend — interactive CLI chat with Claude.
 *
 * Same architecture as the Telegram frontend: implements the Frontend
 * interface so the dispatcher, backend, pulse, and cron all work
 * unchanged. MCP tool actions print to the terminal.
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pc from "picocolors";
import type { TalonConfig } from "../../util/config.js";
import type { ContextManager } from "../../core/types.js";
import { log } from "../../util/log.js";

// ── State ───────────────────────────────────────────────────────────────────

let activeChatId: number | null = null;
let messageCount = 0;
let busy = false;
let server: ReturnType<typeof createServer> | null = null;
let bridgePort = 0;
let rl: ReadlineInterface | null = null;

const TERMINAL_CHAT_ID = 1;

// ── Terminal output helpers ─────────────────────────────────────────────────

/** Clear current line completely */
function clearLine(): void {
  process.stdout.write("\x1b[2K\r");
}

/** Write a line of output without corrupting readline */
function output(text: string): void {
  // Move to start of line, clear it, write our content
  clearLine();
  process.stdout.write(text + "\n");
}

const PROMPT = `  ${pc.green("you")}  `;

/** Re-show the prompt after all output is done */
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
  // Pause readline — prevent it from redrawing the prompt over our spinner
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
  // Resume readline
  if (rl) rl.resume();
}

// ── Bridge action handler ───────────────────────────────────────────────────

function handleTerminalAction(body: Record<string, unknown>): unknown {
  const action = body.action as string;

  switch (action) {
    case "send_message": {
      stopSpinner();
      output(`\n${pc.cyan("  Talon")}  ${String(body.text ?? "")}\n`);
      messageCount++;
      return { ok: true, message_id: Date.now() };
    }

    case "react": {
      stopSpinner();
      output(`\n${pc.cyan("  Talon")}  ${String(body.emoji ?? "\uD83D\uDC4D")}\n`);
      messageCount++;
      return { ok: true };
    }

    case "send_message_with_buttons": {
      stopSpinner();
      const text = String(body.text ?? "");
      const rows = body.rows as Array<Array<{ text: string }>> | undefined;
      let out = `\n${pc.cyan("  Talon")}  ${text}`;
      if (rows) {
        for (const row of rows) {
          out += "\n  " + row.map((b) => pc.dim(`[${b.text}]`)).join("  ");
        }
      }
      output(out + "\n");
      messageCount++;
      return { ok: true, message_id: Date.now() };
    }

    case "edit_message":
    case "delete_message":
    case "pin_message":
    case "unpin_message":
    case "forward_message":
    case "copy_message":
    case "send_chat_action":
      return { ok: true };

    case "read_history":
      return { ok: true, text: "Terminal mode — no chat history." };

    case "search_history":
      return { ok: true, text: "Terminal mode — search not available." };

    case "list_known_users":
      return { ok: true, text: "Terminal user" };

    case "get_chat_info":
      return { ok: true, id: TERMINAL_CHAT_ID, type: "private", title: "Terminal" };

    default:
      return { ok: true, text: `"${action}" not available in terminal mode.` };
  }
}

// ── Bridge server ───────────────────────────────────────────────────────────

function startTerminalBridge(port = 19877): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, mode: "terminal", uptime: Math.round(process.uptime()) }));
          return;
        }
        if (req.method !== "POST" || req.url !== "/action") {
          res.writeHead(404); res.end("Not found"); return;
        }
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          const result = handleTerminalAction(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err) }));
        }
      },
    );

    let attempt = 0;
    const tryPort = (p: number) => {
      httpServer.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && attempt < 5) {
          attempt++;
          httpServer.removeAllListeners("error");
          tryPort(p + 1);
        } else {
          reject(err);
        }
      });
      httpServer.listen(p, "127.0.0.1", () => {
        server = httpServer;
        bridgePort = p;
        resolve(p);
      });
    };
    tryPort(port);
  });
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
    acquire: () => { activeChatId = TERMINAL_CHAT_ID; busy = true; },
    release: () => { activeChatId = null; busy = false; },
    isBusy: () => busy,
    getMessageCount: () => messageCount,
  };

  return {
    context,

    sendTyping: async () => {
      startSpinner();
    },

    sendMessage: async (_chatId: number, text: string) => {
      stopSpinner();
      output(`\n${pc.cyan("  Talon")}  ${text}\n`);
    },

    getBridgePort: () => bridgePort,

    async init() {
      const port = await startTerminalBridge(19877);
      log("bot", `Terminal bridge on port ${port}`);
    },

    async start() {
      console.log();
      console.log(`  ${pc.bold(pc.cyan("\uD83E\uDD85 Talon"))}  ${pc.dim("terminal mode")}`);
      console.log(`  ${pc.dim("Type a message and press Enter. Ctrl+C to quit.")}`);
      console.log(`  ${pc.dim("\u2500".repeat(50))}`);
      console.log();

      const { execute } = await import("../../core/dispatcher.js");

      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: PROMPT,
      });

      rl.prompt();

      rl.on("line", async (input) => {
        const text = input.trim();
        if (!text) { reprompt(); return; }

        if (text === "/quit" || text === "/exit") {
          rl!.close();
          return;
        }

        if (text === "/reset") {
          const { resetSession } = await import("../../storage/sessions.js");
          const { clearHistory } = await import("../../storage/history.js");
          resetSession(String(TERMINAL_CHAT_ID));
          clearHistory(String(TERMINAL_CHAT_ID));
          output(pc.dim("\n  Session cleared.\n"));
          reprompt();
          return;
        }

        if (text === "/help") {
          output([
            "",
            `  ${pc.dim("/reset")}   Clear session`,
            `  ${pc.dim("/quit")}    Exit`,
            `  ${pc.dim("/help")}    This message`,
            "",
          ].join("\n"));
          reprompt();
          return;
        }

        messageCount = 0;

        try {
          const result = await execute({
            chatId: String(TERMINAL_CHAT_ID),
            numericChatId: TERMINAL_CHAT_ID,
            prompt: text,
            senderName: "User",
            isGroup: false,
            source: "message",
          });

          stopSpinner();

          if (messageCount === 0 && result.text && result.text.length > 20) {
            output(`\n${pc.cyan("  Talon")}  ${result.text}\n`);
          }
          reprompt();
        } catch (err) {
          stopSpinner();
          output(`\n  ${pc.red("Error:")} ${err instanceof Error ? err.message : err}\n`);
          reprompt();
        }
      });

      rl.on("close", () => {
        console.log(`\n  ${pc.dim("Goodbye!")}\n`);
        process.exit(0);
      });

      await new Promise(() => {});
    },

    async stop() {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => { server = null; resolve(); });
        });
      }
    },
  };
}
