/**
 * HTTP bridge that the MCP telegram-tools server calls to execute
 * Telegram actions. Runs in the main bot process on localhost.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Bot, InputFile as GrammyInputFile } from "grammy";
import { markdownToTelegramHtml } from "./telegram.js";
import { getRecentFormatted, searchHistory, getMessagesByUser, getKnownUsers } from "./history.js";
import {
  isUserClientReady,
  searchMessages as userbotSearch,
  getHistory as userbotHistory,
  getParticipantDetails as userbotParticipantDetails,
  getUserInfo as userbotGetUserInfo,
  getMessage as userbotGetMessage,
} from "./userbot.js";

type BridgeAction = {
  action: string;
  [key: string]: unknown;
};

let activeChatId: number | null = null;
let botInstance: Bot | null = null;
let InputFileClass: typeof GrammyInputFile | null = null;
let messagesSentViaBridge = 0;
const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

const TELEGRAM_MAX_TEXT = 4096;

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

export function getBridgeMessageCount(): number {
  return messagesSentViaBridge;
}

// ── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
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
        console.log(`[bridge] Retry ${attempt + 1}/3 after ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

// ── Send helpers ─────────────────────────────────────────────────────────────

async function sendText(bot: Bot, chatId: number, text: string, replyTo?: number): Promise<number> {
  if (text.length > TELEGRAM_MAX_TEXT) {
    throw new Error(`Message too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT}). Split into shorter messages.`);
  }
  const html = markdownToTelegramHtml(text);
  const params = { parse_mode: "HTML" as const, reply_parameters: replyTo ? { message_id: replyTo } : undefined };
  try {
    const sent = await bot.api.sendMessage(chatId, html, params);
    return sent.message_id;
  } catch {
    const sent = await bot.api.sendMessage(chatId, text, { reply_parameters: params.reply_parameters });
    return sent.message_id;
  }
}

// ── Action handler ───────────────────────────────────────────────────────────

async function handleAction(body: BridgeAction): Promise<unknown> {
  if (!botInstance || !activeChatId || !InputFileClass) {
    return { ok: false, error: "No active chat context" };
  }
  const chatId = activeChatId;
  const bot = botInstance;

  try {
    switch (body.action) {
      case "send_message": {
        const text = String(body.text ?? "");
        const replyTo = typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : undefined;
        console.log(`[bridge] send_message${replyTo ? ` reply_to=${replyTo}` : ""}: ${text.slice(0, 80)}`);
        messagesSentViaBridge++;
        const msgId = await withRetry(() => sendText(bot, chatId, text, replyTo));
        return { ok: true, message_id: msgId };
      }

      case "reply_to": {
        const msgId = Number(body.message_id);
        const text = String(body.text ?? "");
        console.log(`[bridge] reply_to msg=${msgId}: ${text.slice(0, 80)}`);
        messagesSentViaBridge++;
        const sentId = await withRetry(() => sendText(bot, chatId, text, msgId));
        return { ok: true, message_id: sentId };
      }

      case "react": {
        const msgId = Number(body.message_id);
        const emoji = String(body.emoji ?? "👍");
        console.log(`[bridge] react msg=${msgId} emoji=${emoji}`);
        messagesSentViaBridge++;
        try {
          await withRetry(() => bot.api.setMessageReaction(chatId, msgId, [{ type: "emoji", emoji: emoji as "👍" }]));
        } catch {
          try {
            await bot.api.setMessageReaction(chatId, msgId, [{ type: "emoji", emoji: "👍" }]);
          } catch (e2) {
            return { ok: false, error: `Reaction failed: ${e2 instanceof Error ? e2.message : e2}` };
          }
        }
        return { ok: true };
      }

      case "edit_message": {
        const msgId = Number(body.message_id);
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT) {
          return { ok: false, error: `Text too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT})` };
        }
        console.log(`[bridge] edit msg=${msgId}: ${text.slice(0, 80)}`);
        const html = markdownToTelegramHtml(text);
        await withRetry(async () => {
          try { await bot.api.editMessageText(chatId, msgId, html, { parse_mode: "HTML" }); }
          catch { await bot.api.editMessageText(chatId, msgId, text); }
        });
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

      case "unpin_message": {
        const msgId = body.message_id ? Number(body.message_id) : undefined;
        console.log(`[bridge] unpin${msgId ? ` msg=${msgId}` : " latest"}`);
        await bot.api.unpinChatMessage(chatId, msgId ? { message_id: msgId } : undefined);
        return { ok: true };
      }

      case "send_file": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        console.log(`[bridge] send_file: ${basename(filePath)}`);
        messagesSentViaBridge++;
        const stat = statSync(filePath);
        if (stat.size > 49 * 1024 * 1024) return { ok: false, error: "File too large (max 49MB)" };
        const data = readFileSync(filePath);
        const sent = await withRetry(() => bot.api.sendDocument(chatId, new InputFileClass!(data, basename(filePath)), { caption }));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_photo": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        console.log(`[bridge] send_photo: ${basename(filePath)}`);
        messagesSentViaBridge++;
        const data = readFileSync(filePath);
        const sent = await withRetry(() => bot.api.sendPhoto(chatId, new InputFileClass!(data, basename(filePath)), { caption }));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_sticker": {
        const fileId = String(body.file_id ?? "");
        console.log(`[bridge] send_sticker`);
        messagesSentViaBridge++;
        const sent = await bot.api.sendSticker(chatId, fileId);
        return { ok: true, message_id: sent.message_id };
      }

      case "send_video": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        console.log(`[bridge] send_video: ${basename(filePath)}`);
        messagesSentViaBridge++;
        const data = readFileSync(filePath);
        const sent = await withRetry(() => bot.api.sendVideo(chatId, new InputFileClass!(data, basename(filePath)), { caption }));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_animation": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        console.log(`[bridge] send_animation: ${basename(filePath)}`);
        messagesSentViaBridge++;
        const data = readFileSync(filePath);
        const sent = await withRetry(() => bot.api.sendAnimation(chatId, new InputFileClass!(data, basename(filePath)), { caption }));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_voice": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        console.log(`[bridge] send_voice: ${basename(filePath)}`);
        messagesSentViaBridge++;
        const data = readFileSync(filePath);
        const sent = await withRetry(() => bot.api.sendVoice(chatId, new InputFileClass!(data, basename(filePath)), { caption }));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT) {
          return { ok: false, error: `Text too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT})` };
        }
        const html = markdownToTelegramHtml(text);
        const rows = body.rows as Array<Array<{ text: string; url?: string; callback_data?: string }>>;
        console.log(`[bridge] send_message_with_buttons: ${text.slice(0, 60)}`);
        messagesSentViaBridge++;
        const keyboard = rows.map((row) =>
          row.map((btn) => btn.url ? { text: btn.text, url: btn.url } : { text: btn.text, callback_data: btn.callback_data ?? btn.text }),
        );
        try {
          const sent = await bot.api.sendMessage(chatId, html, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
          return { ok: true, message_id: sent.message_id };
        } catch {
          const sent = await bot.api.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
          return { ok: true, message_id: sent.message_id };
        }
      }

      case "send_chat_action": {
        const action = String(body.chat_action ?? "typing");
        console.log(`[bridge] send_chat_action: ${action}`);
        await bot.api.sendChatAction(chatId, action as "typing");
        return { ok: true };
      }

      case "schedule_message": {
        const text = String(body.text ?? "");
        const delaySec = Math.max(1, Math.min(3600, Number(body.delay_seconds ?? 60)));
        const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        console.log(`[bridge] schedule_message: "${text.slice(0, 40)}" in ${delaySec}s`);
        const timer = setTimeout(async () => {
          try { await sendText(bot, chatId, text); }
          catch (err) { console.error(`[bridge] scheduled send failed:`, err); }
          scheduledMessages.delete(scheduleId);
        }, delaySec * 1000);
        scheduledMessages.set(scheduleId, timer);
        return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
      }

      case "cancel_scheduled": {
        const scheduleId = String(body.schedule_id ?? "");
        const timer = scheduledMessages.get(scheduleId);
        if (timer) {
          clearTimeout(timer);
          scheduledMessages.delete(scheduleId);
          return { ok: true, cancelled: true };
        }
        return { ok: false, error: `Schedule ${scheduleId} not found` };
      }

      case "send_poll": {
        const question = String(body.question ?? "");
        const options = (body.options as string[]) ?? [];
        console.log(`[bridge] send_poll: "${question}" (${options.length} options)`);
        messagesSentViaBridge++;
        const sent = await bot.api.sendPoll(chatId, question, options.map(o => ({ text: o })), {
          is_anonymous: body.is_anonymous as boolean | undefined,
          allows_multiple_answers: body.allows_multiple_answers as boolean | undefined,
          type: body.type as "regular" | "quiz" | undefined,
          correct_option_id: body.correct_option_id as number | undefined,
          explanation: body.explanation as string | undefined,
        });
        return { ok: true, message_id: sent.message_id };
      }

      case "send_location": {
        console.log(`[bridge] send_location`);
        messagesSentViaBridge++;
        const sent = await bot.api.sendLocation(chatId, Number(body.latitude), Number(body.longitude));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_contact": {
        console.log(`[bridge] send_contact`);
        messagesSentViaBridge++;
        const sent = await bot.api.sendContact(chatId, String(body.phone_number), String(body.first_name), { last_name: body.last_name as string | undefined });
        return { ok: true, message_id: sent.message_id };
      }

      case "send_dice": {
        const emoji = (body.emoji as string) || "🎲";
        console.log(`[bridge] send_dice: ${emoji}`);
        messagesSentViaBridge++;
        const sent = await bot.api.sendDice(chatId, { emoji: emoji as "🎲" });
        return { ok: true, message_id: sent.message_id, value: sent.dice?.value };
      }

      case "forward_message": {
        const msgId = Number(body.message_id);
        const toChatId = body.to_chat_id ? Number(body.to_chat_id) : chatId;
        console.log(`[bridge] forward msg=${msgId}`);
        const sent = await bot.api.forwardMessage(toChatId, chatId, msgId);
        return { ok: true, message_id: sent.message_id };
      }

      case "copy_message": {
        const msgId = Number(body.message_id);
        console.log(`[bridge] copy msg=${msgId}`);
        const sent = await bot.api.copyMessage(chatId, chatId, msgId);
        return { ok: true, message_id: sent.message_id };
      }

      case "get_chat_info": {
        const chat = await bot.api.getChat(chatId);
        const count = await bot.api.getChatMemberCount(chatId).catch(() => null);
        return { ok: true, id: chat.id, type: chat.type, title: "title" in chat ? chat.title : undefined, member_count: count };
      }

      case "get_chat_member": {
        const userId = Number(body.user_id);
        const member = await bot.api.getChatMember(chatId, userId);
        return { ok: true, status: member.status, user: { id: member.user.id, first_name: member.user.first_name, username: member.user.username } };
      }

      case "get_chat_admins": {
        const admins = await bot.api.getChatAdministrators(chatId);
        const text = admins.map((a) => {
          const name = [a.user.first_name, a.user.last_name].filter(Boolean).join(" ");
          const title = "custom_title" in a && a.custom_title ? ` "${a.custom_title}"` : "";
          return `${name}${title} (${a.status}) id:${a.user.id}`;
        }).join("\n");
        return { ok: true, text };
      }

      case "get_chat_member_count": {
        const count = await bot.api.getChatMemberCount(chatId);
        return { ok: true, count };
      }

      case "set_chat_title": {
        await bot.api.setChatTitle(chatId, String(body.title));
        return { ok: true };
      }

      case "set_chat_description": {
        await bot.api.setChatDescription(chatId, String(body.description ?? ""));
        return { ok: true };
      }

      // ── History tools ──────────────────────────────────────────────────

      case "list_known_users": {
        if (isUserClientReady()) {
          const text = await userbotParticipantDetails({ chatId, limit: Number(body.limit ?? 50) });
          return { ok: true, text };
        }
        return { ok: true, text: getKnownUsers(String(chatId)) };
      }

      case "get_member_info": {
        const userId = Number(body.user_id);
        if (isUserClientReady()) {
          const text = await userbotGetUserInfo({ chatId, userId });
          return { ok: true, text };
        }
        return { ok: false, error: "User client not connected." };
      }

      case "read_history": {
        const limit = Math.min(100, Number(body.limit ?? 30));
        if (isUserClientReady()) {
          const text = await userbotHistory({ chatId, limit, offsetId: body.offset_id as number | undefined, before: body.before as string | undefined });
          return { ok: true, text };
        }
        return { ok: true, text: getRecentFormatted(String(chatId), limit) };
      }

      case "search_history": {
        const query = String(body.query ?? "");
        const limit = Math.min(100, Number(body.limit ?? 20));
        if (isUserClientReady()) {
          const text = await userbotSearch({ chatId, query, limit });
          return { ok: true, text };
        }
        return { ok: true, text: searchHistory(String(chatId), query, limit) };
      }

      case "get_user_messages": {
        const userName = String(body.user_name ?? "");
        const limit = Math.min(50, Number(body.limit ?? 20));
        if (isUserClientReady()) {
          const text = await userbotSearch({ chatId, query: userName, limit });
          return { ok: true, text };
        }
        return { ok: true, text: getMessagesByUser(String(chatId), userName, limit) };
      }

      case "get_message_by_id": {
        const msgId = Number(body.message_id);
        if (isUserClientReady()) {
          const text = await userbotGetMessage({ chatId, messageId: msgId });
          return { ok: true, text };
        }
        return { ok: false, error: "User client not connected." };
      }

      default:
        return { ok: false, error: `Unknown action: ${body.action}` };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] "${body.action}" failed: ${errMsg}`);
    return { ok: false, error: `${body.action}: ${errMsg}` };
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

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
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
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
  });

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
        console.log(`[bridge] Telegram action bridge on :${p}`);
        resolve(p);
      });
    };
    tryPort(port);
  });
}

export function stopBridge(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => { server = null; activePort = 0; resolve(); });
  });
}
