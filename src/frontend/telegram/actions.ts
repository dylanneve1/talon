/**
 * Telegram-specific action handlers.
 *
 * Handles MCP tool actions that require the Telegram Bot API.
 * Platform-agnostic actions (cron, fetch_url, history) are handled
 * by core/gateway-actions.ts before this is called.
 */

import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Bot, InputFile as GrammyInputFile } from "grammy";
import { markdownToTelegramHtml } from "./formatting.js";
import {
  isUserClientReady,
  searchMessages as userbotSearch,
  getHistory as userbotHistory,
  getParticipantDetails as userbotParticipantDetails,
  getUserInfo as userbotGetUserInfo,
  getMessage as userbotGetMessage,
  getPinnedMessages as userbotPinnedMessages,
  getOnlineCount as userbotOnlineCount,
  saveStickerPack as userbotSaveStickerPack,
} from "./userbot.js";
import { withRetry, incrementMessageCount } from "../../core/gateway.js";
import type { ActionResult } from "../../core/types.js";

const TELEGRAM_MAX_TEXT = 4096;

// ── Helpers ─────────────────────────────────────────────────────────────────

function replyParams(body: Record<string, unknown>): { message_id: number } | undefined {
  const replyTo = body.reply_to ?? body.reply_to_message_id;
  return typeof replyTo === "number" && replyTo > 0 ? { message_id: replyTo } : undefined;
}

export async function sendText(
  bot: Bot,
  chatId: number,
  text: string,
  replyTo?: number,
): Promise<number> {
  if (text.length > TELEGRAM_MAX_TEXT) {
    throw new Error(`Message too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT}).`);
  }
  const html = markdownToTelegramHtml(text);
  try {
    const sent = await bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
    return sent.message_id;
  } catch {
    const sent = await bot.api.sendMessage(chatId, text, {
      reply_parameters: replyTo ? { message_id: replyTo } : undefined,
    });
    return sent.message_id;
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Telegram action handler bound to a specific bot instance.
 * Returns a FrontendActionHandler that the gateway calls for Telegram-specific actions.
 */
export function createTelegramActionHandler(
  bot: Bot,
  InputFileClass: typeof GrammyInputFile,
  botToken: string,
) {
  const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

  return async (body: Record<string, unknown>, chatId: string): Promise<ActionResult | null> => {
    const action = body.action as string;
    const numChatId = Number(chatId.replace(/^tg:/, ""));

    switch (action) {
      // ── Messaging ─────────────────────────────────────────────────────
      case "send_message": {
        const text = String(body.text ?? "");
        const replyTo = typeof body.reply_to_message_id === "number" ? body.reply_to_message_id : undefined;
        incrementMessageCount();
        const msgId = await withRetry(() => sendText(bot, numChatId, text, replyTo));
        return { ok: true, message_id: msgId };
      }

      case "reply_to": {
        const msgId = Number(body.message_id);
        incrementMessageCount();
        const sentId = await withRetry(() => sendText(bot, numChatId, String(body.text ?? ""), msgId));
        return { ok: true, message_id: sentId };
      }

      case "react": {
        incrementMessageCount();
        const emoji = String(body.emoji ?? "\uD83D\uDC4D");
        try {
          await withRetry(() => bot.api.setMessageReaction(numChatId, Number(body.message_id), [
            { type: "emoji", emoji: emoji as "\uD83D\uDC4D" },
          ]));
        } catch {
          try {
            await bot.api.setMessageReaction(numChatId, Number(body.message_id), [
              { type: "emoji", emoji: "\uD83D\uDC4D" },
            ]);
          } catch (e) { return { ok: false, error: `Reaction failed: ${e instanceof Error ? e.message : e}` }; }
        }
        return { ok: true };
      }

      case "edit_message": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT) return { ok: false, error: `Text too long (max ${TELEGRAM_MAX_TEXT})` };
        const html = markdownToTelegramHtml(text);
        await withRetry(async () => {
          try { await bot.api.editMessageText(numChatId, Number(body.message_id), html, { parse_mode: "HTML" }); }
          catch { await bot.api.editMessageText(numChatId, Number(body.message_id), text); }
        });
        return { ok: true };
      }

      case "delete_message":
        await bot.api.deleteMessage(numChatId, Number(body.message_id));
        return { ok: true };

      case "pin_message":
        await bot.api.pinChatMessage(numChatId, Number(body.message_id));
        return { ok: true };

      case "unpin_message":
        await bot.api.unpinChatMessage(numChatId, body.message_id ? Number(body.message_id) : undefined);
        return { ok: true };

      case "forward_message": {
        if (body.to_chat_id && Number(body.to_chat_id) !== numChatId)
          return { ok: false, error: "Cross-chat forwarding not allowed." };
        const sent = await bot.api.forwardMessage(numChatId, numChatId, Number(body.message_id));
        return { ok: true, message_id: sent.message_id };
      }

      case "copy_message": {
        const sent = await bot.api.copyMessage(numChatId, numChatId, Number(body.message_id));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_chat_action":
        await bot.api.sendChatAction(numChatId, String(body.chat_action ?? "typing") as "typing");
        return { ok: true };

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT) return { ok: false, error: `Text too long` };
        const html = markdownToTelegramHtml(text);
        const rows = body.rows as Array<Array<{ text: string; url?: string; callback_data?: string }>>;
        incrementMessageCount();
        const keyboard = rows.map((row) => row.map((btn) =>
          btn.url ? { text: btn.text, url: btn.url } : { text: btn.text, callback_data: btn.callback_data ?? btn.text },
        ));
        try {
          const sent = await bot.api.sendMessage(numChatId, html, { parse_mode: "HTML", reply_markup: { inline_keyboard: keyboard } });
          return { ok: true, message_id: sent.message_id };
        } catch {
          const sent = await bot.api.sendMessage(numChatId, text, { reply_markup: { inline_keyboard: keyboard } });
          return { ok: true, message_id: sent.message_id };
        }
      }

      case "schedule_message": {
        const text = String(body.text ?? "");
        const delaySec = Math.max(1, Math.min(3600, Number(body.delay_seconds ?? 60)));
        const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(async () => {
          try { await sendText(bot, numChatId, text); } catch { /* scheduled send failed */ }
          scheduledMessages.delete(scheduleId);
        }, delaySec * 1000);
        scheduledMessages.set(scheduleId, timer);
        return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
      }

      case "cancel_scheduled": {
        const timer = scheduledMessages.get(String(body.schedule_id ?? ""));
        if (timer) { clearTimeout(timer); scheduledMessages.delete(String(body.schedule_id)); return { ok: true, cancelled: true }; }
        return { ok: false, error: "Schedule not found" };
      }

      // ── Media ──────────────────────────────────────────────────────────
      case "send_file": case "send_photo": case "send_video": case "send_animation": case "send_voice": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        incrementMessageCount();
        if (action === "send_file") {
          const stat = statSync(filePath);
          if (stat.size > 49 * 1024 * 1024) return { ok: false, error: "File too large (max 49MB)" };
        }
        const data = readFileSync(filePath);
        const file = new InputFileClass(data, basename(filePath));
        const rp = replyParams(body);
        let sent;
        switch (action) {
          case "send_file": sent = await withRetry(() => bot.api.sendDocument(numChatId, file, { caption, reply_parameters: rp })); break;
          case "send_photo": sent = await withRetry(() => bot.api.sendPhoto(numChatId, file, { caption, reply_parameters: rp })); break;
          case "send_video": sent = await withRetry(() => bot.api.sendVideo(numChatId, file, { caption, reply_parameters: rp })); break;
          case "send_animation": sent = await withRetry(() => bot.api.sendAnimation(numChatId, file, { caption, reply_parameters: rp })); break;
          default: sent = await withRetry(() => bot.api.sendVoice(numChatId, file, { caption, reply_parameters: rp })); break;
        }
        return { ok: true, message_id: sent.message_id };
      }

      case "send_sticker": {
        incrementMessageCount();
        const sent = await bot.api.sendSticker(numChatId, String(body.file_id ?? ""), { reply_parameters: replyParams(body) });
        return { ok: true, message_id: sent.message_id };
      }

      case "send_poll": {
        incrementMessageCount();
        const sent = await bot.api.sendPoll(numChatId, String(body.question ?? ""),
          (body.options as string[] ?? []).map((o) => ({ text: o })),
          { is_anonymous: body.is_anonymous as boolean | undefined, allows_multiple_answers: body.allows_multiple_answers as boolean | undefined,
            type: body.type as "regular" | "quiz" | undefined, correct_option_id: body.correct_option_id as number | undefined,
            explanation: body.explanation as string | undefined });
        return { ok: true, message_id: sent.message_id };
      }

      case "send_location": {
        incrementMessageCount();
        const sent = await bot.api.sendLocation(numChatId, Number(body.latitude), Number(body.longitude));
        return { ok: true, message_id: sent.message_id };
      }

      case "send_contact": {
        incrementMessageCount();
        const sent = await bot.api.sendContact(numChatId, String(body.phone_number), String(body.first_name),
          { last_name: body.last_name as string | undefined });
        return { ok: true, message_id: sent.message_id };
      }

      case "send_dice": {
        incrementMessageCount();
        const sent = await bot.api.sendDice(numChatId, (body.emoji as string) || "\uD83C\uDFB2");
        return { ok: true, message_id: sent.message_id, value: sent.dice?.value };
      }

      // ── Chat info ──────────────────────────────────────────────────────
      case "get_chat_info": {
        const chat = await bot.api.getChat(numChatId);
        const count = await bot.api.getChatMemberCount(numChatId).catch(() => null);
        return { ok: true, id: chat.id, type: chat.type, title: "title" in chat ? chat.title : undefined, member_count: count };
      }

      case "get_chat_member": {
        const m = await bot.api.getChatMember(numChatId, Number(body.user_id));
        return { ok: true, status: m.status, user: { id: m.user.id, first_name: m.user.first_name, username: m.user.username } };
      }

      case "get_chat_admins": {
        const admins = await bot.api.getChatAdministrators(numChatId);
        const text = admins.map((a) => {
          const name = [a.user.first_name, a.user.last_name].filter(Boolean).join(" ");
          const title = "custom_title" in a && a.custom_title ? ` "${a.custom_title}"` : "";
          return `${name}${title} (${a.status}) id:${a.user.id}`;
        }).join("\n");
        return { ok: true, text };
      }

      case "get_chat_member_count":
        return { ok: true, count: await bot.api.getChatMemberCount(numChatId) };

      case "set_chat_title":
        await bot.api.setChatTitle(numChatId, String(body.title));
        return { ok: true };

      case "set_chat_description":
        await bot.api.setChatDescription(numChatId, String(body.description ?? ""));
        return { ok: true };

      // ── History (userbot-enhanced) ─────────────────────────────────────
      // These OVERRIDE the shared in-memory history when userbot is available
      case "read_history":
        if (isUserClientReady()) {
          return { ok: true, text: await userbotHistory({ chatId: numChatId, limit: Math.min(100, Number(body.limit ?? 30)), offsetId: body.offset_id as number | undefined, before: body.before as string | undefined }) };
        }
        return null; // fall through to shared handler

      case "search_history":
        if (isUserClientReady()) {
          return { ok: true, text: await userbotSearch({ chatId: numChatId, query: String(body.query ?? ""), limit: Math.min(100, Number(body.limit ?? 20)) }) };
        }
        return null;

      case "get_user_messages":
        if (isUserClientReady()) {
          return { ok: true, text: await userbotSearch({ chatId: numChatId, query: String(body.user_name ?? ""), limit: Math.min(50, Number(body.limit ?? 20)) }) };
        }
        return null;

      case "list_known_users":
        if (isUserClientReady()) {
          return { ok: true, text: await userbotParticipantDetails({ chatId: numChatId, limit: Number(body.limit ?? 50) }) };
        }
        return null;

      case "get_member_info":
        if (isUserClientReady()) {
          return { ok: true, text: await userbotGetUserInfo({ chatId: numChatId, userId: Number(body.user_id) }) };
        }
        return { ok: false, error: "User client not connected." };

      case "get_message_by_id":
        if (isUserClientReady()) {
          return { ok: true, text: await userbotGetMessage({ chatId: numChatId, messageId: Number(body.message_id) }) };
        }
        return { ok: false, error: "User client not connected." };

      case "get_pinned_messages":
        if (isUserClientReady()) return { ok: true, text: await userbotPinnedMessages({ chatId: numChatId }) };
        return { ok: false, error: "User client not connected." };

      case "online_count":
        if (isUserClientReady()) return { ok: true, text: await userbotOnlineCount({ chatId: numChatId }) };
        return { ok: false, error: "User client not connected." };

      case "save_sticker_pack": {
        const text = await userbotSaveStickerPack({ setName: String(body.set_name ?? ""), bot });
        return { ok: true, text };
      }

      case "get_sticker_pack": {
        const stickerSet = await bot.api.getStickerSet(String(body.set_name ?? ""));
        const lines = stickerSet.stickers.map((s, i) => `${i + 1}. ${s.emoji ?? ""} [${s.is_animated ? "animated" : s.is_video ? "video" : "static"}] file_id: ${s.file_id}`);
        return { ok: true, text: `Sticker pack: "${stickerSet.title}" (${stickerSet.stickers.length} stickers)\nSet name: ${stickerSet.name}\n\n${lines.join("\n")}` };
      }

      case "download_sticker": {
        const file = await bot.api.getFile(String(body.file_id ?? ""));
        if (!file.file_path) return { ok: false, error: "Could not get file path" };
        const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) return { ok: false, error: `Download failed: ${resp.status}` };
        const buffer = Buffer.from(await resp.arrayBuffer());
        const ext = file.file_path.split(".").pop() ?? "webp";
        const uploadsDir = resolve(process.cwd(), "workspace", "uploads");
        if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
        const filePath = resolve(uploadsDir, `${Date.now()}-sticker.${ext}`);
        writeFileSync(filePath, buffer);
        return { ok: true, text: `Downloaded sticker to: ${filePath} (${buffer.length} bytes).` };
      }

      case "download_media": {
        if (isUserClientReady()) {
          const { downloadMessageMedia } = await import("./userbot.js");
          return { ok: true, text: await downloadMessageMedia({ chatId: numChatId, messageId: Number(body.message_id) }) };
        }
        return { ok: false, error: "User client not connected." };
      }

      default:
        return null; // not a Telegram action
    }
  };
}
