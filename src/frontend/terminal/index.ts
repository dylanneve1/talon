/**
 * Terminal frontend — interactive CLI chat with Claude.
 *
 * Same architecture as the Telegram frontend: implements the Frontend
 * interface so the dispatcher, backend, pulse, and cron all work
 * unchanged. MCP tool actions print to the terminal instead of
 * calling Telegram API.
 */

import { createInterface } from "node:readline";
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

// The "chat ID" for the terminal session
const TERMINAL_CHAT_ID = 1;

// ── Bridge action handler (prints to terminal) ─────────────────────────────

function handleTerminalAction(body: Record<string, unknown>): unknown {
  const action = body.action as string;

  switch (action) {
    case "send_message": {
      const text = String(body.text ?? "");
      console.log(`\n${pc.cyan("  Talon")}  ${text}\n`);
      messageCount++;
      return { ok: true, message_id: Date.now() };
    }

    case "react": {
      const emoji = String(body.emoji ?? "👍");
      process.stdout.write(`  ${emoji}\n`);
      messageCount++;
      return { ok: true };
    }

    case "send_message_with_buttons": {
      const text = String(body.text ?? "");
      const rows = body.rows as Array<Array<{ text: string }>> | undefined;
      console.log(`\n${pc.cyan("  Talon")}  ${text}`);
      if (rows) {
        for (const row of rows) {
          const buttons = row.map((b) => pc.dim(`[${b.text}]`)).join("  ");
          console.log(`  ${buttons}`);
        }
      }
      console.log();
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
      return { ok: true, text: "Terminal mode — no chat history available." };

    case "search_history":
      return { ok: true, text: "Terminal mode — search not available." };

    case "list_known_users":
      return { ok: true, text: "Terminal user" };

    case "get_chat_info":
      return { ok: true, id: TERMINAL_CHAT_ID, type: "private", title: "Terminal" };

    default:
      return { ok: true, text: `Action "${action}" not available in terminal mode.` };
  }
}

// ── Bridge server (same HTTP interface as Telegram bridge) ──────────────────

function startTerminalBridge(port = 19876): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const httpServer = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, mode: "terminal", uptime: Math.round(process.uptime()) }));
          return;
        }

        if (req.method !== "POST" || req.url !== "/action") {
          res.writeHead(404);
          res.end("Not found");
          return;
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
      process.stdout.write(pc.dim("  thinking...\r"));
    },

    sendMessage: async (_chatId: number, text: string) => {
      console.log(`\n${pc.cyan("  Talon")}  ${text}\n`);
    },

    getBridgePort: () => bridgePort,

    async init() {
      const port = await startTerminalBridge(19877); // different port from Telegram
      log("bot", `Terminal bridge on port ${port}`);
    },

    async start() {
      console.log();
      console.log(`  ${pc.bold(pc.cyan("🦅 Talon"))}  ${pc.dim("terminal mode")}`);
      console.log(`  ${pc.dim("Type a message and press Enter. Ctrl+C to quit.")}`);
      console.log(`  ${pc.dim("─".repeat(50))}`);
      console.log();

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: `  ${pc.green("you")}  `,
      });

      // Import dispatcher to send messages
      const { execute } = await import("../../core/dispatcher.js");

      rl.prompt();

      rl.on("line", async (input) => {
        const text = input.trim();
        if (!text) { rl.prompt(); return; }

        if (text === "/quit" || text === "/exit") {
          rl.close();
          return;
        }

        if (text === "/reset") {
          const { resetSession } = await import("../../storage/sessions.js");
          const { clearHistory } = await import("../../storage/history.js");
          resetSession(String(TERMINAL_CHAT_ID));
          clearHistory(String(TERMINAL_CHAT_ID));
          console.log(`  ${pc.dim("Session cleared.")}\n`);
          rl.prompt();
          return;
        }

        if (text === "/status") {
          try {
            const resp = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
              signal: AbortSignal.timeout(1000),
            });
            const h = await resp.json() as Record<string, unknown>;
            console.log(`  ${pc.dim("uptime:")} ${h.uptime}s  ${pc.dim("mode:")} ${h.mode}\n`);
          } catch {
            console.log(`  ${pc.dim("health check failed")}\n`);
          }
          rl.prompt();
          return;
        }

        messageCount = 0; // reset for this turn

        try {
          const result = await execute({
            chatId: String(TERMINAL_CHAT_ID),
            numericChatId: TERMINAL_CHAT_ID,
            prompt: text,
            senderName: "User",
            isGroup: false,
            source: "message",
          });

          // If no tools sent messages, print the response directly
          if (messageCount === 0 && result.text && result.text.length > 20) {
            console.log(`\n${pc.cyan("  Talon")}  ${result.text}\n`);
          }
        } catch (err) {
          console.log(`  ${pc.red("Error:")} ${err instanceof Error ? err.message : err}\n`);
        }

        rl.prompt();
      });

      rl.on("close", () => {
        console.log(`\n  ${pc.dim("Goodbye!")}\n`);
        process.exit(0);
      });

      // Keep alive
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
