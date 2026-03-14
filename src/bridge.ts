/**
 * HTTP bridge that the MCP telegram-tools server calls to execute
 * Telegram actions. Runs in the main bot process on localhost.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Bot, InputFile as GrammyInputFile } from "grammy";
import { markdownToTelegramHtml } from "./telegram.js";

type BridgeAction = {
  action: string;
  [key: string]: unknown;
};

let activeChatId: number | null = null;
let botInstance: Bot | null = null;
let InputFileClass: typeof GrammyInputFile | null = null;
let messagesSentViaBridge = 0;

export function setBridgeContext(chatId: number, bot: Bot, inputFile: typeof GrammyInputFile): void {
  activeChatId = chatId;
  botInstance = bot;
  InputFileClass = inputFile;
  messagesSentViaBridge = 0;
}

export function clearBridgeContext(): void {
  activeChatId = null;
  messagesSentViaBridge = 0;
}

/** Number of messages/files sent via bridge tools during the current turn. */
export function getBridgeMessageCount(): number {
  return messagesSentViaBridge;
}

async function handleAction(body: BridgeAction): Promise<unknown> {
  if (!botInstance || !activeChatId || !InputFileClass) {
    throw new Error("No active chat context");
  }
  const chatId = activeChatId;
  const bot = botInstance;

  switch (body.action) {
    case "send_message": {
      const text = String(body.text ?? "");
      const html = markdownToTelegramHtml(text);
      const replyTo = typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : undefined;
      console.log(`[bridge] send_message${replyTo ? ` reply_to=${replyTo}` : ""}: ${text.slice(0, 80)}`);
      messagesSentViaBridge++;
      try {
        const sent = await bot.api.sendMessage(chatId, html, {
          parse_mode: "HTML",
          reply_parameters: replyTo ? { message_id: replyTo } : undefined,
        });
        return { ok: true, message_id: sent.message_id };
      } catch {
        const sent = await bot.api.sendMessage(chatId, text, {
          reply_parameters: replyTo ? { message_id: replyTo } : undefined,
        });
        return { ok: true, message_id: sent.message_id };
      }
    }

    case "reply_to": {
      const msgId = Number(body.message_id);
      const text = String(body.text ?? "");
      const html = markdownToTelegramHtml(text);
      console.log(`[bridge] reply_to msg=${msgId}: ${text.slice(0, 80)}`);
      messagesSentViaBridge++;
      try {
        const sent = await bot.api.sendMessage(chatId, html, {
          parse_mode: "HTML",
          reply_parameters: { message_id: msgId },
        });
        return { ok: true, message_id: sent.message_id };
      } catch {
        const sent = await bot.api.sendMessage(chatId, text, {
          reply_parameters: { message_id: msgId },
        });
        return { ok: true, message_id: sent.message_id };
      }
    }

    case "react": {
      const msgId = Number(body.message_id);
      const emoji = String(body.emoji ?? "👍");
      console.log(`[bridge] react msg=${msgId} emoji=${emoji}`);
      await bot.api.setMessageReaction(chatId, msgId, [{ type: "emoji", emoji: emoji as "👍" }]);
      return { ok: true };
    }

    case "edit_message": {
      const msgId = Number(body.message_id);
      const text = String(body.text ?? "");
      console.log(`[bridge] edit msg=${msgId}: ${text.slice(0, 80)}`);
      const html = markdownToTelegramHtml(text);
      try {
        await bot.api.editMessageText(chatId, msgId, html, { parse_mode: "HTML" });
      } catch {
        await bot.api.editMessageText(chatId, msgId, text);
      }
      return { ok: true };
    }

    case "delete_message": {
      const msgId = Number(body.message_id);
      console.log(`[bridge] delete msg=${msgId}`);
      await bot.api.deleteMessage(chatId, msgId);
      return { ok: true };
    }

    case "pin_message": {
      const msgId = Number(body.message_id);
      console.log(`[bridge] pin msg=${msgId}`);
      await bot.api.pinChatMessage(chatId, msgId);
      return { ok: true };
    }

    case "send_file": {
      const filePath = String(body.file_path ?? "");
      const caption = body.caption ? String(body.caption) : undefined;
      console.log(`[bridge] send_file: ${basename(filePath)}`);
      messagesSentViaBridge++;
      const stat = statSync(filePath);
      if (stat.size > 49 * 1024 * 1024) throw new Error("File too large (max 49MB)");
      const data = readFileSync(filePath);
      const sent = await bot.api.sendDocument(chatId, new InputFileClass(data, basename(filePath)), {
        caption,
      });
      return { ok: true, message_id: sent.message_id };
    }

    case "send_photo": {
      const filePath = String(body.file_path ?? "");
      const caption = body.caption ? String(body.caption) : undefined;
      console.log(`[bridge] send_photo: ${basename(filePath)}`);
      messagesSentViaBridge++;
      const data = readFileSync(filePath);
      const sent = await bot.api.sendPhoto(chatId, new InputFileClass(data, basename(filePath)), {
        caption,
      });
      return { ok: true, message_id: sent.message_id };
    }

    default:
      throw new Error(`Unknown action: ${body.action}`);
  }
}

let server: ReturnType<typeof createServer> | null = null;

export function startBridge(port = 19876): void {
  if (server) return;

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/action") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as BridgeAction;

      const result = await handleAction(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[bridge] Action error:", msg);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`[bridge] Telegram action bridge on :${port}`);
  });
}
