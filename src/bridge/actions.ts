/**
 * Bridge action handlers — processes Telegram actions dispatched by the MCP tools server.
 */

import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { markdownToTelegramHtml } from "../telegram/formatting.js";
import {
  getRecentFormatted,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
} from "../storage/history.js";
import {
  isUserClientReady,
  searchMessages as userbotSearch,
  getHistory as userbotHistory,
  getParticipantDetails as userbotParticipantDetails,
  getUserInfo as userbotGetUserInfo,
  getMessage as userbotGetMessage,
} from "../telegram/userbot.js";
import { log, logError } from "../util/log.js";
import {
  getActiveChatId,
  getBotInstance,
  getInputFileClass,
  getBotToken,
  incrementBridgeMessageCount,
  getScheduledMessages,
  TELEGRAM_MAX_TEXT,
  withRetry,
  replyParams,
  sendText,
} from "./server.js";

type BridgeAction = {
  action: string;
  [key: string]: unknown;
};

export async function handleAction(body: BridgeAction): Promise<unknown> {
  const activeChatId = getActiveChatId();
  const botInstance = getBotInstance();
  const InputFileClass = getInputFileClass();

  if (!botInstance || !activeChatId || !InputFileClass) {
    return { ok: false, error: "No active chat context" };
  }
  const chatId = activeChatId;
  const bot = botInstance;

  try {
    switch (body.action) {
      case "send_message": {
        const text = String(body.text ?? "");
        const replyTo =
          typeof body.reply_to_message_id === "number"
            ? body.reply_to_message_id
            : undefined;
        log(
          "bridge",
          `send_message${replyTo ? ` reply_to=${replyTo}` : ""}: ${text.slice(0, 80)}`,
        );
        incrementBridgeMessageCount();
        const msgId = await withRetry(() =>
          sendText(bot, chatId, text, replyTo),
        );
        return { ok: true, message_id: msgId };
      }

      case "reply_to": {
        const msgId = Number(body.message_id);
        const text = String(body.text ?? "");
        log("bridge", `reply_to msg=${msgId}: ${text.slice(0, 80)}`);
        incrementBridgeMessageCount();
        const sentId = await withRetry(() =>
          sendText(bot, chatId, text, msgId),
        );
        return { ok: true, message_id: sentId };
      }

      case "react": {
        const msgId = Number(body.message_id);
        const emoji = String(body.emoji ?? "\uD83D\uDC4D");
        log("bridge", `react msg=${msgId} emoji=${emoji}`);
        incrementBridgeMessageCount();
        try {
          await withRetry(() =>
            bot.api.setMessageReaction(chatId, msgId, [
              { type: "emoji", emoji: emoji as "\uD83D\uDC4D" },
            ]),
          );
        } catch {
          try {
            await bot.api.setMessageReaction(chatId, msgId, [
              { type: "emoji", emoji: "\uD83D\uDC4D" },
            ]);
          } catch (e2) {
            return {
              ok: false,
              error: `Reaction failed: ${e2 instanceof Error ? e2.message : e2}`,
            };
          }
        }
        return { ok: true };
      }

      case "edit_message": {
        const msgId = Number(body.message_id);
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT) {
          return {
            ok: false,
            error: `Text too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT})`,
          };
        }
        log("bridge", `edit msg=${msgId}: ${text.slice(0, 80)}`);
        const html = markdownToTelegramHtml(text);
        await withRetry(async () => {
          try {
            await bot.api.editMessageText(chatId, msgId, html, {
              parse_mode: "HTML",
            });
          } catch {
            await bot.api.editMessageText(chatId, msgId, text);
          }
        });
        return { ok: true };
      }

      case "delete_message": {
        const msgId = Number(body.message_id);
        log("bridge", `delete msg=${msgId}`);
        await bot.api.deleteMessage(chatId, msgId);
        return { ok: true };
      }

      case "pin_message": {
        const msgId = Number(body.message_id);
        log("bridge", `pin msg=${msgId}`);
        await bot.api.pinChatMessage(chatId, msgId);
        return { ok: true };
      }

      case "unpin_message": {
        const msgId = body.message_id ? Number(body.message_id) : undefined;
        log("bridge", `unpin${msgId ? ` msg=${msgId}` : " latest"}`);
        await bot.api.unpinChatMessage(chatId, msgId);
        return { ok: true };
      }

      case "send_file": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        log("bridge", `send_file: ${basename(filePath)}`);
        incrementBridgeMessageCount();
        const stat = statSync(filePath);
        if (stat.size > 49 * 1024 * 1024)
          return { ok: false, error: "File too large (max 49MB)" };
        const data = readFileSync(filePath);
        const sent = await withRetry(() =>
          bot.api.sendDocument(
            chatId,
            new InputFileClass!(data, basename(filePath)),
            { caption, reply_parameters: replyParams(body) },
          ),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_photo": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        log("bridge", `send_photo: ${basename(filePath)}`);
        incrementBridgeMessageCount();
        const data = readFileSync(filePath);
        const sent = await withRetry(() =>
          bot.api.sendPhoto(
            chatId,
            new InputFileClass!(data, basename(filePath)),
            { caption, reply_parameters: replyParams(body) },
          ),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_sticker": {
        const fileId = String(body.file_id ?? "");
        log("bridge", `send_sticker`);
        incrementBridgeMessageCount();
        const sent = await bot.api.sendSticker(chatId, fileId, {
          reply_parameters: replyParams(body),
        });
        return { ok: true, message_id: sent.message_id };
      }

      case "send_video": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        log("bridge", `send_video: ${basename(filePath)}`);
        incrementBridgeMessageCount();
        const data = readFileSync(filePath);
        const sent = await withRetry(() =>
          bot.api.sendVideo(
            chatId,
            new InputFileClass!(data, basename(filePath)),
            { caption, reply_parameters: replyParams(body) },
          ),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_animation": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        log("bridge", `send_animation: ${basename(filePath)}`);
        incrementBridgeMessageCount();
        const data = readFileSync(filePath);
        const sent = await withRetry(() =>
          bot.api.sendAnimation(
            chatId,
            new InputFileClass!(data, basename(filePath)),
            { caption, reply_parameters: replyParams(body) },
          ),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_voice": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        log("bridge", `send_voice: ${basename(filePath)}`);
        incrementBridgeMessageCount();
        const data = readFileSync(filePath);
        const sent = await withRetry(() =>
          bot.api.sendVoice(
            chatId,
            new InputFileClass!(data, basename(filePath)),
            { caption, reply_parameters: replyParams(body) },
          ),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT) {
          return {
            ok: false,
            error: `Text too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT})`,
          };
        }
        const html = markdownToTelegramHtml(text);
        const rows = body.rows as Array<
          Array<{ text: string; url?: string; callback_data?: string }>
        >;
        log("bridge", `send_message_with_buttons: ${text.slice(0, 60)}`);
        incrementBridgeMessageCount();
        const keyboard = rows.map((row) =>
          row.map((btn) =>
            btn.url
              ? { text: btn.text, url: btn.url }
              : {
                  text: btn.text,
                  callback_data: btn.callback_data ?? btn.text,
                },
          ),
        );
        try {
          const sent = await bot.api.sendMessage(chatId, html, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: keyboard },
          });
          return { ok: true, message_id: sent.message_id };
        } catch {
          const sent = await bot.api.sendMessage(chatId, text, {
            reply_markup: { inline_keyboard: keyboard },
          });
          return { ok: true, message_id: sent.message_id };
        }
      }

      case "send_chat_action": {
        const action = String(body.chat_action ?? "typing");
        log("bridge", `send_chat_action: ${action}`);
        await bot.api.sendChatAction(chatId, action as "typing");
        return { ok: true };
      }

      case "schedule_message": {
        const text = String(body.text ?? "");
        const delaySec = Math.max(
          1,
          Math.min(3600, Number(body.delay_seconds ?? 60)),
        );
        const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        log(
          "bridge",
          `schedule_message: "${text.slice(0, 40)}" in ${delaySec}s`,
        );
        const scheduledMessages = getScheduledMessages();
        const timer = setTimeout(async () => {
          try {
            await sendText(bot, chatId, text);
          } catch (err) {
            logError("bridge", `scheduled send failed:`, err);
          }
          scheduledMessages.delete(scheduleId);
        }, delaySec * 1000);
        scheduledMessages.set(scheduleId, timer);
        return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
      }

      case "cancel_scheduled": {
        const scheduleId = String(body.schedule_id ?? "");
        const scheduledMessages = getScheduledMessages();
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
        log("bridge", `send_poll: "${question}" (${options.length} options)`);
        incrementBridgeMessageCount();
        const sent = await bot.api.sendPoll(
          chatId,
          question,
          options.map((o) => ({ text: o })),
          {
            is_anonymous: body.is_anonymous as boolean | undefined,
            allows_multiple_answers: body.allows_multiple_answers as
              | boolean
              | undefined,
            type: body.type as "regular" | "quiz" | undefined,
            correct_option_id: body.correct_option_id as number | undefined,
            explanation: body.explanation as string | undefined,
          },
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_location": {
        log("bridge", `send_location`);
        incrementBridgeMessageCount();
        const sent = await bot.api.sendLocation(
          chatId,
          Number(body.latitude),
          Number(body.longitude),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_contact": {
        log("bridge", `send_contact`);
        incrementBridgeMessageCount();
        const sent = await bot.api.sendContact(
          chatId,
          String(body.phone_number),
          String(body.first_name),
          { last_name: body.last_name as string | undefined },
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_dice": {
        const emoji = (body.emoji as string) || "\uD83C\uDFB2";
        log("bridge", `send_dice: ${emoji}`);
        incrementBridgeMessageCount();
        const sent = await bot.api.sendDice(chatId, emoji as never);
        return {
          ok: true,
          message_id: sent.message_id,
          value: sent.dice?.value,
        };
      }

      case "forward_message": {
        const msgId = Number(body.message_id);
        // Security: reject cross-chat forwards to prevent scope bypass
        if (body.to_chat_id && Number(body.to_chat_id) !== chatId) {
          return { ok: false, error: "Cross-chat forwarding is not allowed. Messages can only be forwarded within the active chat." };
        }
        log("bridge", `forward msg=${msgId}`);
        const sent = await bot.api.forwardMessage(chatId, chatId, msgId);
        return { ok: true, message_id: sent.message_id };
      }

      case "copy_message": {
        const msgId = Number(body.message_id);
        log("bridge", `copy msg=${msgId}`);
        const sent = await bot.api.copyMessage(chatId, chatId, msgId);
        return { ok: true, message_id: sent.message_id };
      }

      case "get_chat_info": {
        const chat = await bot.api.getChat(chatId);
        const count = await bot.api
          .getChatMemberCount(chatId)
          .catch(() => null);
        return {
          ok: true,
          id: chat.id,
          type: chat.type,
          title: "title" in chat ? chat.title : undefined,
          member_count: count,
        };
      }

      case "get_chat_member": {
        const userId = Number(body.user_id);
        const member = await bot.api.getChatMember(chatId, userId);
        return {
          ok: true,
          status: member.status,
          user: {
            id: member.user.id,
            first_name: member.user.first_name,
            username: member.user.username,
          },
        };
      }

      case "get_chat_admins": {
        const admins = await bot.api.getChatAdministrators(chatId);
        const text = admins
          .map((a) => {
            const name = [a.user.first_name, a.user.last_name]
              .filter(Boolean)
              .join(" ");
            const title =
              "custom_title" in a && a.custom_title
                ? ` "${a.custom_title}"`
                : "";
            return `${name}${title} (${a.status}) id:${a.user.id}`;
          })
          .join("\n");
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
        await bot.api.setChatDescription(
          chatId,
          String(body.description ?? ""),
        );
        return { ok: true };
      }

      // ── History tools ──────────────────────────────────────────────────

      case "list_known_users": {
        if (isUserClientReady()) {
          const text = await userbotParticipantDetails({
            chatId,
            limit: Number(body.limit ?? 50),
          });
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
          const text = await userbotHistory({
            chatId,
            limit,
            offsetId: body.offset_id as number | undefined,
            before: body.before as string | undefined,
          });
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
        return {
          ok: true,
          text: getMessagesByUser(String(chatId), userName, limit),
        };
      }

      case "get_message_by_id": {
        const msgId = Number(body.message_id);
        if (isUserClientReady()) {
          const text = await userbotGetMessage({ chatId, messageId: msgId });
          return { ok: true, text };
        }
        return { ok: false, error: "User client not connected." };
      }

      case "get_sticker_pack": {
        const setName = String(body.set_name ?? "");
        log("bridge", `get_sticker_pack: ${setName}`);
        try {
          const stickerSet = await bot.api.getStickerSet(setName);
          const lines = stickerSet.stickers.map((s, i) => {
            const emoji = s.emoji ?? "";
            const type = s.is_animated ? "animated" : s.is_video ? "video" : "static";
            return `${i + 1}. ${emoji} [${type}] file_id: ${s.file_id}`;
          });
          const header = `Sticker pack: "${stickerSet.title}" (${stickerSet.stickers.length} stickers)\nSet name: ${stickerSet.name}`;
          return { ok: true, text: `${header}\n\n${lines.join("\n")}` };
        } catch (err) {
          return { ok: false, error: `Failed to get sticker pack: ${err instanceof Error ? err.message : err}` };
        }
      }

      case "download_sticker": {
        const fileId = String(body.file_id ?? "");
        log("bridge", `download_sticker`);
        try {
          const file = await bot.api.getFile(fileId);
          if (!file.file_path) return { ok: false, error: "Could not get file path" };

          const botToken = getBotToken();
          if (!botToken) return { ok: false, error: "Bot token not set" };
          const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
          const resp = await fetch(url);
          if (!resp.ok) return { ok: false, error: `Download failed: ${resp.status}` };

          const buffer = Buffer.from(await resp.arrayBuffer());
          const ext = file.file_path.split(".").pop() ?? "webp";
          const uploadsDir = resolve(process.cwd(), "workspace", "uploads");
          if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
          const filename = `${Date.now()}-sticker.${ext}`;
          const filePath = resolve(uploadsDir, filename);
          writeFileSync(filePath, buffer);

          return { ok: true, text: `Downloaded sticker to: ${filePath} (${buffer.length} bytes). You can view it with the Read tool.` };
        } catch (err) {
          return { ok: false, error: `Failed: ${err instanceof Error ? err.message : err}` };
        }
      }

      case "download_media": {
        const msgId = Number(body.message_id);
        log("bridge", `download_media msg=${msgId}`);
        if (isUserClientReady()) {
          const { downloadMessageMedia } = await import("../telegram/userbot.js");
          const result = await downloadMessageMedia({ chatId, messageId: msgId });
          return { ok: true, text: result };
        }
        return { ok: false, error: "User client not connected. Media download requires user session." };
      }

      default:
        return { ok: false, error: `Unknown action: ${body.action}` };
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError("bridge", `"${body.action}" failed: ${errMsg}`);
    return { ok: false, error: `${body.action}: ${errMsg}` };
  }
}
