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
  getParticipants as userbotParticipants,
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
    return { ok: false, error: "No active chat context" };
  }
  const chatId = activeChatId;
  const bot = botInstance;

  try {
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
      const lat = Number(body.latitude);
      const lon = Number(body.longitude);
      console.log(`[bridge] send_location: ${lat},${lon}`);
      messagesSentViaBridge++;
      const sent = await bot.api.sendLocation(chatId, lat, lon);
      return { ok: true, message_id: sent.message_id };
    }

    case "send_contact": {
      const phone = String(body.phone_number ?? "");
      const firstName = String(body.first_name ?? "");
      const lastName = body.last_name ? String(body.last_name) : undefined;
      console.log(`[bridge] send_contact: ${firstName} ${phone}`);
      messagesSentViaBridge++;
      const sent = await bot.api.sendContact(chatId, phone, firstName, { last_name: lastName });
      return { ok: true, message_id: sent.message_id };
    }

    case "send_dice": {
      const emoji = (body.emoji as string) || "🎲";
      console.log(`[bridge] send_dice: ${emoji}`);
      messagesSentViaBridge++;
      const sent = await bot.api.sendDice(chatId, { emoji: emoji as "🎲" });
      return { ok: true, message_id: sent.message_id, value: sent.dice?.value };
    }

    case "send_sticker": {
      const fileId = String(body.file_id ?? "");
      console.log(`[bridge] send_sticker: ${fileId.slice(0, 40)}`);
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
      const sent = await bot.api.sendVideo(chatId, new InputFileClass(data, basename(filePath)), {
        caption,
      });
      return { ok: true, message_id: sent.message_id };
    }

    case "send_animation": {
      const filePath = String(body.file_path ?? "");
      const caption = body.caption ? String(body.caption) : undefined;
      console.log(`[bridge] send_animation: ${basename(filePath)}`);
      messagesSentViaBridge++;
      const data = readFileSync(filePath);
      const sent = await bot.api.sendAnimation(chatId, new InputFileClass(data, basename(filePath)), {
        caption,
      });
      return { ok: true, message_id: sent.message_id };
    }

    case "send_voice": {
      const filePath = String(body.file_path ?? "");
      const caption = body.caption ? String(body.caption) : undefined;
      console.log(`[bridge] send_voice: ${basename(filePath)}`);
      messagesSentViaBridge++;
      const data = readFileSync(filePath);
      const sent = await bot.api.sendVoice(chatId, new InputFileClass(data, basename(filePath)), {
        caption,
      });
      return { ok: true, message_id: sent.message_id };
    }

    case "send_message_with_buttons": {
      const text = String(body.text ?? "");
      const html = markdownToTelegramHtml(text);
      const rows = body.rows as Array<Array<{ text: string; url?: string; callback_data?: string }>>;
      console.log(`[bridge] send_message_with_buttons: ${text.slice(0, 60)}`);
      messagesSentViaBridge++;
      const inlineKeyboard = rows.map((row) =>
        row.map((btn) => {
          if (btn.url) return { text: btn.text, url: btn.url };
          return { text: btn.text, callback_data: btn.callback_data ?? btn.text };
        }),
      );
      try {
        const sent = await bot.api.sendMessage(chatId, html, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
        return { ok: true, message_id: sent.message_id };
      } catch {
        const sent = await bot.api.sendMessage(chatId, text, {
          reply_markup: { inline_keyboard: inlineKeyboard },
        });
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
      console.log(`[bridge] schedule_message: "${text.slice(0, 40)}" in ${delaySec}s (${scheduleId})`);
      const timer = setTimeout(async () => {
        try {
          const html = markdownToTelegramHtml(text);
          try {
            await bot.api.sendMessage(chatId, html, { parse_mode: "HTML" });
          } catch {
            await bot.api.sendMessage(chatId, text);
          }
          console.log(`[bridge] scheduled message sent: ${scheduleId}`);
        } catch (err) {
          console.error(`[bridge] scheduled message failed (${scheduleId}):`, err);
        }
        scheduledMessages.delete(scheduleId);
      }, delaySec * 1000);
      scheduledMessages.set(scheduleId, timer);
      return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
    }

    case "cancel_scheduled": {
      const scheduleId = String(body.schedule_id ?? "");
      console.log(`[bridge] cancel_scheduled: ${scheduleId}`);
      const timer = scheduledMessages.get(scheduleId);
      if (timer) {
        clearTimeout(timer);
        scheduledMessages.delete(scheduleId);
        return { ok: true, cancelled: true };
      }
      return { ok: false, error: `Schedule ${scheduleId} not found or already sent` };
    }

    case "forward_message": {
      const msgId = Number(body.message_id);
      const toChatId = body.to_chat_id ? Number(body.to_chat_id) : chatId;
      console.log(`[bridge] forward msg=${msgId} to=${toChatId}`);
      const sent = await bot.api.forwardMessage(toChatId, chatId, msgId);
      return { ok: true, message_id: sent.message_id };
    }

    case "unpin_message": {
      const msgId = body.message_id ? Number(body.message_id) : undefined;
      console.log(`[bridge] unpin${msgId ? ` msg=${msgId}` : " latest"}`);
      if (msgId) {
        await bot.api.unpinChatMessage(chatId, { message_id: msgId });
      } else {
        await bot.api.unpinChatMessage(chatId);
      }
      return { ok: true };
    }

    case "get_chat_info": {
      console.log(`[bridge] get_chat_info`);
      const chat = await bot.api.getChat(chatId);
      const count = await bot.api.getChatMemberCount(chatId).catch(() => null);
      return {
        ok: true,
        id: chat.id,
        type: chat.type,
        title: "title" in chat ? chat.title : undefined,
        username: "username" in chat ? chat.username : undefined,
        description: "description" in chat ? chat.description : undefined,
        member_count: count,
      };
    }

    case "get_chat_member": {
      const userId = Number(body.user_id);
      console.log(`[bridge] get_chat_member user=${userId}`);
      const member = await bot.api.getChatMember(chatId, userId);
      return {
        ok: true,
        status: member.status,
        user: {
          id: member.user.id,
          first_name: member.user.first_name,
          last_name: member.user.last_name,
          username: member.user.username,
          is_bot: member.user.is_bot,
        },
      };
    }

    case "set_chat_title": {
      const title = String(body.title ?? "");
      console.log(`[bridge] set_chat_title: "${title}"`);
      await bot.api.setChatTitle(chatId, title);
      return { ok: true };
    }

    case "set_chat_description": {
      const desc = String(body.description ?? "");
      console.log(`[bridge] set_chat_description`);
      await bot.api.setChatDescription(chatId, desc);
      return { ok: true };
    }

    case "list_known_users": {
      console.log(`[bridge] list_known_users`);
      // Prefer userbot for real participant list
      if (isUserClientReady()) {
        const text = await userbotParticipants({ chatId, limit: Number(body.limit ?? 50), query: body.query as string | undefined });
        return { ok: true, text };
      }
      const text = getKnownUsers(String(chatId));
      return { ok: true, text };
    }

    case "read_history": {
      const limit = Math.min(100, Number(body.limit ?? 30));
      // Prefer userbot for real Telegram history
      if (isUserClientReady()) {
        const text = await userbotHistory({
          chatId,
          limit,
          offsetId: body.offset_id as number | undefined,
          before: body.before as string | number | undefined,
        });
        return { ok: true, text };
      }
      const text = getRecentFormatted(String(chatId), limit);
      return { ok: true, text };
    }

    case "search_history": {
      const query = String(body.query ?? "");
      const limit = Math.min(100, Number(body.limit ?? 20));
      // Prefer userbot for real Telegram search
      if (isUserClientReady()) {
        const text = await userbotSearch({ chatId, query, limit });
        return { ok: true, text };
      }
      const text = searchHistory(String(chatId), query, limit);
      return { ok: true, text };
    }

    case "get_user_messages": {
      const userName = String(body.user_name ?? "");
      const limit = Math.min(50, Number(body.limit ?? 20));
      // Userbot search by name
      if (isUserClientReady()) {
        const text = await userbotSearch({ chatId, query: userName, limit });
        return { ok: true, text };
      }
      const text = getMessagesByUser(String(chatId), userName, limit);
      return { ok: true, text };
    }

    case "get_message_by_id": {
      const msgId = Number(body.message_id);
      if (isUserClientReady()) {
        const text = await userbotGetMessage({ chatId, messageId: msgId });
        return { ok: true, text };
      }
      return { ok: false, error: "User client not connected. Message lookup by ID requires user session." };
    }

    default:
      return { ok: false, error: `Unknown action: ${body.action}` };
  }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] Action "${body.action}" failed: ${errMsg}`);
    return { ok: false, error: `${body.action} failed: ${errMsg}` };
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
