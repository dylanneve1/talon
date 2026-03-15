/**
 * HTTP bridge that the MCP telegram-tools server calls to execute
 * Telegram actions. Runs in the main bot process on localhost.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Bot, InputFile as GrammyInputFile } from "grammy";
import { markdownToTelegramHtml } from "../telegram/formatting.js";
import { log, logError } from "../util/log.js";
import { handleAction } from "./actions.js";

type BridgeAction = {
  action: string;
  [key: string]: unknown;
};

let activeChatId: number | null = null;
let botInstance: Bot | null = null;
let InputFileClass: typeof GrammyInputFile | null = null;
let botToken: string | null = null;
let messagesSentViaBridge = 0;
let bridgeLocked = false;
let bridgeOwner: string | null = null;
const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

const TELEGRAM_MAX_TEXT = 4096;

export function setBridgeBotToken(token: string): void {
  botToken = token;
}

export function setBridgeContext(
  chatId: number,
  bot: Bot,
  inputFile: typeof GrammyInputFile,
): void {
  activeChatId = chatId;
  botInstance = bot;
  InputFileClass = inputFile;
  messagesSentViaBridge = 0;
  bridgeLocked = true;
  bridgeOwner = String(chatId);
}

export function isBridgeBusy(): boolean {
  return bridgeLocked;
}

/** Clear bridge context. Only clears if the given chatId owns it. */
export function clearBridgeContext(chatId?: number | string): void {
  if (chatId !== undefined && bridgeOwner !== String(chatId)) return;
  activeChatId = null;
  messagesSentViaBridge = 0;
  bridgeLocked = false;
  bridgeOwner = null;
}

export function getBridgeMessageCount(): number {
  return messagesSentViaBridge;
}

// ── Accessors for actions module ──────────────────────────────────────────────

export function getActiveChatId(): number | null {
  return activeChatId;
}

export function getBotInstance(): Bot | null {
  return botInstance;
}

export function getInputFileClass(): typeof GrammyInputFile | null {
  return InputFileClass;
}

export function getBotToken(): string | null {
  return botToken;
}

export function incrementBridgeMessageCount(): void {
  messagesSentViaBridge++;
}

export function getScheduledMessages(): Map<string, ReturnType<typeof setTimeout>> {
  return scheduledMessages;
}

export { TELEGRAM_MAX_TEXT };

// ── Retry helper ─────────────────────────────────────────────────────────────

export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const statusMatch = msg.match(/(\d{3})/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      if (status === 400 || status === 403) throw err;
      if (attempt < 2) {
        let delayMs = 1000 * Math.pow(2, attempt);
        if (status === 429) {
          const retryMatch = msg.match(/retry.?after[:\s]*(\d+)/i);
          if (retryMatch) delayMs = parseInt(retryMatch[1], 10) * 1000;
        }
        log("bridge", `Retry ${attempt + 1}/3 after ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// ── Send helpers ─────────────────────────────────────────────────────────────

export function replyParams(body: BridgeAction): { message_id: number } | undefined {
  const replyTo = body.reply_to ?? body.reply_to_message_id;
  return typeof replyTo === "number" && replyTo > 0
    ? { message_id: replyTo }
    : undefined;
}

export async function sendText(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo?: number,
): Promise<number> {
  if (text.length > TELEGRAM_MAX_TEXT) {
    throw new Error(
      `Message too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT}). Split into shorter messages.`,
    );
  }
  const html = markdownToTelegramHtml(text);
  const params = {
    parse_mode: "HTML" as const,
    reply_parameters: replyTo ? { message_id: replyTo } : undefined,
  };
  try {
    const sent = await bot.api.sendMessage(chatId, html, params);
    return sent.message_id;
  } catch {
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: params.reply_parameters,
    });
    return sent.message_id;
  }
}

// ── HTTP server ──────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer> | null = null;
let activePort = 0;

export function getBridgePort(): number {
  return activePort;
}

export function startBridge(port = 19876): Promise<number> {
  if (server) return Promise.resolve(activePort);

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST" || req.url !== "/action") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(
          Buffer.concat(chunks).toString("utf-8"),
        ) as BridgeAction;
        const result = await handleAction(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: msg }));
      }
    },
  );

  return new Promise<number>((resolve, reject) => {
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
        activePort = p;
        log("bridge", `Telegram action bridge on :${p}`);
        resolve(p);
      });
    };
    tryPort(port);
  });
}

export function stopBridge(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => {
      server = null;
      activePort = 0;
      resolve();
    });
  });
}
