/**
 * Telegram-specific action handlers.
 *
 * Handles MCP tool actions that require the Telegram Bot API.
 * Platform-agnostic actions (cron, fetch_url, history) are handled
 * by core/gateway-actions.ts before this is called.
 */

import {
  readFileSync,
  statSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { dirs } from "../../util/paths.js";
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
import { withRetry } from "../../core/gateway.js";
import type { Gateway } from "../../core/gateway.js";
import type { ActionResult } from "../../core/types.js";

const TELEGRAM_MAX_TEXT = 4096;

// ── Helpers ─────────────────────────────────────────────────────────────────

function replyParams(
  body: Record<string, unknown>,
): { message_id: number } | undefined {
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
      `Message too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT}).`,
    );
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
  gateway: Gateway,
) {
  const scheduledMessages = new Map<string, ReturnType<typeof setTimeout>>();

  return async (
    body: Record<string, unknown>,
    chatId: number,
  ): Promise<ActionResult | null> => {
    const action = body.action as string;

    switch (action) {
      // ── Messaging ─────────────────────────────────────────────────────
      case "send_message": {
        const text = String(body.text ?? "");
        const replyTo =
          typeof body.reply_to_message_id === "number"
            ? body.reply_to_message_id
            : undefined;
        gateway.incrementMessages(chatId);
        const msgId = await withRetry(() =>
          sendText(bot, chatId, text, replyTo),
        );
        return { ok: true, message_id: msgId };
      }

      case "reply_to": {
        const msgId = Number(body.message_id);
        gateway.incrementMessages(chatId);
        const sentId = await withRetry(() =>
          sendText(bot, chatId, String(body.text ?? ""), msgId),
        );
        return { ok: true, message_id: sentId };
      }

      case "react": {
        gateway.incrementMessages(chatId);
        const emoji = String(body.emoji ?? "\uD83D\uDC4D");
        try {
          await withRetry(() =>
            bot.api.setMessageReaction(chatId, Number(body.message_id), [
              { type: "emoji", emoji: emoji as "\uD83D\uDC4D" },
            ]),
          );
        } catch {
          try {
            await bot.api.setMessageReaction(chatId, Number(body.message_id), [
              { type: "emoji", emoji: "\uD83D\uDC4D" },
            ]);
          } catch (e) {
            return {
              ok: false,
              error: `Reaction failed: ${e instanceof Error ? e.message : e}`,
            };
          }
        }
        return { ok: true };
      }

      case "edit_message": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT)
          return {
            ok: false,
            error: `Text too long (max ${TELEGRAM_MAX_TEXT})`,
          };
        const html = markdownToTelegramHtml(text);
        await withRetry(async () => {
          try {
            await bot.api.editMessageText(
              chatId,
              Number(body.message_id),
              html,
              { parse_mode: "HTML" },
            );
          } catch {
            await bot.api.editMessageText(
              chatId,
              Number(body.message_id),
              text,
            );
          }
        });
        return { ok: true };
      }

      case "delete_message":
        await bot.api.deleteMessage(chatId, Number(body.message_id));
        return { ok: true };

      case "pin_message":
        await bot.api.pinChatMessage(chatId, Number(body.message_id));
        return { ok: true };

      case "unpin_message":
        await bot.api.unpinChatMessage(
          chatId,
          body.message_id ? Number(body.message_id) : undefined,
        );
        return { ok: true };

      case "forward_message": {
        if (body.to_chat_id && Number(body.to_chat_id) !== chatId)
          return { ok: false, error: "Cross-chat forwarding not allowed." };
        const sent = await bot.api.forwardMessage(
          chatId,
          chatId,
          Number(body.message_id),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "copy_message": {
        const sent = await bot.api.copyMessage(
          chatId,
          chatId,
          Number(body.message_id),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_chat_action":
        await bot.api.sendChatAction(
          chatId,
          String(body.chat_action ?? "typing") as "typing",
        );
        return { ok: true };

      case "send_message_with_buttons": {
        const text = String(body.text ?? "");
        if (text.length > TELEGRAM_MAX_TEXT)
          return { ok: false, error: `Text too long` };
        const html = markdownToTelegramHtml(text);
        const rows = body.rows as Array<
          Array<{ text: string; url?: string; callback_data?: string }>
        >;
        gateway.incrementMessages(chatId);
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

      case "schedule_message": {
        const text = String(body.text ?? "");
        const delaySec = Math.max(
          1,
          Math.min(3600, Number(body.delay_seconds ?? 60)),
        );
        const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timer = setTimeout(async () => {
          try {
            await sendText(bot, chatId, text);
          } catch {
            /* scheduled send failed */
          }
          scheduledMessages.delete(scheduleId);
        }, delaySec * 1000);
        scheduledMessages.set(scheduleId, timer);
        return { ok: true, schedule_id: scheduleId, delay_seconds: delaySec };
      }

      case "cancel_scheduled": {
        const timer = scheduledMessages.get(String(body.schedule_id ?? ""));
        if (timer) {
          clearTimeout(timer);
          scheduledMessages.delete(String(body.schedule_id));
          return { ok: true, cancelled: true };
        }
        return { ok: false, error: "Schedule not found" };
      }

      // ── Media ──────────────────────────────────────────────────────────
      case "send_file":
      case "send_photo":
      case "send_video":
      case "send_animation":
      case "send_voice":
      case "send_audio": {
        const filePath = String(body.file_path ?? "");
        const caption = body.caption ? String(body.caption) : undefined;
        gateway.incrementMessages(chatId);
        if (action === "send_file") {
          const stat = statSync(filePath);
          if (stat.size > 49 * 1024 * 1024)
            return { ok: false, error: "File too large (max 49MB)" };
        }
        const data = readFileSync(filePath);
        const file = new InputFileClass(data, basename(filePath));
        const rp = replyParams(body);
        let sent;
        switch (action) {
          case "send_file":
            sent = await withRetry(() =>
              bot.api.sendDocument(chatId, file, {
                caption,
                reply_parameters: rp,
              }),
            );
            break;
          case "send_photo":
            sent = await withRetry(() =>
              bot.api.sendPhoto(chatId, file, {
                caption,
                reply_parameters: rp,
              }),
            );
            break;
          case "send_video":
            sent = await withRetry(() =>
              bot.api.sendVideo(chatId, file, {
                caption,
                reply_parameters: rp,
              }),
            );
            break;
          case "send_animation":
            sent = await withRetry(() =>
              bot.api.sendAnimation(chatId, file, {
                caption,
                reply_parameters: rp,
              }),
            );
            break;
          case "send_audio":
            sent = await withRetry(() =>
              bot.api.sendAudio(chatId, file, {
                caption,
                reply_parameters: rp,
                title: body.title as string | undefined,
                performer: body.performer as string | undefined,
              }),
            );
            break;
          default:
            sent = await withRetry(() =>
              bot.api.sendVoice(chatId, file, {
                caption,
                reply_parameters: rp,
              }),
            );
            break;
        }
        return { ok: true, message_id: sent.message_id };
      }

      case "send_sticker": {
        gateway.incrementMessages(chatId);
        const sent = await bot.api.sendSticker(
          chatId,
          String(body.file_id ?? ""),
          { reply_parameters: replyParams(body) },
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_poll": {
        gateway.incrementMessages(chatId);
        const sent = await bot.api.sendPoll(
          chatId,
          String(body.question ?? ""),
          ((body.options as string[]) ?? []).map((o) => ({ text: o })),
          {
            is_anonymous: body.is_anonymous as boolean | undefined,
            allows_multiple_answers: body.allows_multiple_answers as
              | boolean
              | undefined,
            type: body.type as "regular" | "quiz" | undefined,
            correct_option_ids: body.correct_option_id != null ? [body.correct_option_id as number] : undefined,
            explanation: body.explanation as string | undefined,
          },
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_location": {
        gateway.incrementMessages(chatId);
        const sent = await bot.api.sendLocation(
          chatId,
          Number(body.latitude),
          Number(body.longitude),
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_contact": {
        gateway.incrementMessages(chatId);
        const sent = await bot.api.sendContact(
          chatId,
          String(body.phone_number),
          String(body.first_name),
          { last_name: body.last_name as string | undefined },
        );
        return { ok: true, message_id: sent.message_id };
      }

      case "send_dice": {
        gateway.incrementMessages(chatId);
        const sent = await bot.api.sendDice(
          chatId,
          (body.emoji as string) || "\uD83C\uDFB2",
        );
        return {
          ok: true,
          message_id: sent.message_id,
          value: sent.dice?.value,
        };
      }

      // ── Chat info ──────────────────────────────────────────────────────
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
        const m = await bot.api.getChatMember(chatId, Number(body.user_id));
        return {
          ok: true,
          status: m.status,
          user: {
            id: m.user.id,
            first_name: m.user.first_name,
            username: m.user.username,
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

      case "get_chat_member_count":
        return { ok: true, count: await bot.api.getChatMemberCount(chatId) };

      case "set_chat_title":
        await bot.api.setChatTitle(chatId, String(body.title));
        return { ok: true };

      case "set_chat_description":
        await bot.api.setChatDescription(
          chatId,
          String(body.description ?? ""),
        );
        return { ok: true };

      // ── History (userbot-enhanced) ─────────────────────────────────────
      // These OVERRIDE the shared in-memory history when userbot is available
      case "read_history":
        if (isUserClientReady()) {
          return {
            ok: true,
            text: await userbotHistory({
              chatId,
              limit: Math.min(100, Number(body.limit ?? 30)),
              offsetId: body.offset_id as number | undefined,
              before: body.before as string | undefined,
            }),
          };
        }
        return null; // fall through to shared handler

      case "search_history":
        if (isUserClientReady()) {
          return {
            ok: true,
            text: await userbotSearch({
              chatId,
              query: String(body.query ?? ""),
              limit: Math.min(100, Number(body.limit ?? 20)),
            }),
          };
        }
        return null;

      case "get_user_messages":
        if (isUserClientReady()) {
          return {
            ok: true,
            text: await userbotSearch({
              chatId,
              query: String(body.user_name ?? ""),
              limit: Math.min(50, Number(body.limit ?? 20)),
            }),
          };
        }
        return null;

      case "list_known_users":
        if (isUserClientReady()) {
          return {
            ok: true,
            text: await userbotParticipantDetails({
              chatId,
              limit: Number(body.limit ?? 50),
            }),
          };
        }
        return null;

      case "get_member_info":
        if (isUserClientReady()) {
          return {
            ok: true,
            text: await userbotGetUserInfo({
              chatId,
              userId: Number(body.user_id),
            }),
          };
        }
        return { ok: false, error: "User client not connected." };

      case "get_message_by_id":
        if (isUserClientReady()) {
          return {
            ok: true,
            text: await userbotGetMessage({
              chatId,
              messageId: Number(body.message_id),
            }),
          };
        }
        return { ok: false, error: "User client not connected." };

      case "get_pinned_messages":
        if (isUserClientReady())
          return { ok: true, text: await userbotPinnedMessages({ chatId }) };
        return { ok: false, error: "User client not connected." };

      case "online_count":
        if (isUserClientReady())
          return { ok: true, text: await userbotOnlineCount({ chatId }) };
        return { ok: false, error: "User client not connected." };

      case "save_sticker_pack": {
        const text = await userbotSaveStickerPack({
          setName: String(body.set_name ?? ""),
          bot,
        });
        return { ok: true, text };
      }

      case "get_sticker_pack": {
        const stickerSet = await bot.api.getStickerSet(
          String(body.set_name ?? ""),
        );
        const lines = stickerSet.stickers.map(
          (s, i) =>
            `${i + 1}. ${s.emoji ?? ""} [${s.is_animated ? "animated" : s.is_video ? "video" : "static"}] file_id: ${s.file_id}`,
        );
        return {
          ok: true,
          text: `Sticker pack: "${stickerSet.title}" (${stickerSet.stickers.length} stickers)\nSet name: ${stickerSet.name}\n\n${lines.join("\n")}`,
        };
      }

      case "download_sticker": {
        const file = await bot.api.getFile(String(body.file_id ?? ""));
        if (!file.file_path)
          return { ok: false, error: "Could not get file path" };
        const url = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok)
          return { ok: false, error: `Download failed: ${resp.status}` };
        const buffer = Buffer.from(await resp.arrayBuffer());
        const ext = file.file_path.split(".").pop() ?? "webp";
        const uploadsDir = dirs.uploads;
        if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
        const filePath = resolve(uploadsDir, `${Date.now()}-sticker.${ext}`);
        writeFileSync(filePath, buffer);
        return {
          ok: true,
          text: `Downloaded sticker to: ${filePath} (${buffer.length} bytes).`,
        };
      }

      // ── Sticker pack management ──────────────────────────────────────
      case "create_sticker_set": {
        const userId = Number(body.user_id);
        const name = String(body.name ?? "");
        const title = String(body.title ?? "");
        const filePath = String(body.file_path ?? "");
        const emojis = (body.emoji_list as string[]) ?? ["🎨"];
        const format =
          (body.format as "static" | "animated" | "video") ?? "static";
        if (!userId || !name || !title || !filePath) {
          return {
            ok: false,
            error: "Required: user_id, name, title, file_path",
          };
        }
        // Sticker set names must end with _by_<bot_username>
        const botUsername = bot.botInfo?.username ?? "";
        const fullName = name.endsWith(`_by_${botUsername}`)
          ? name
          : `${name}_by_${botUsername}`;
        const data = readFileSync(filePath);
        const sticker = {
          sticker: new InputFileClass(data, basename(filePath)),
          format,
          emoji_list: emojis,
        };
        await bot.api.createNewStickerSet(userId, fullName, title, [sticker]);
        return {
          ok: true,
          text: `Created sticker pack "${title}" (${fullName}) with 1 sticker.`,
        };
      }

      case "add_sticker_to_set": {
        const userId = Number(body.user_id);
        const name = String(body.name ?? "");
        const filePath = String(body.file_path ?? "");
        const emojis = (body.emoji_list as string[]) ?? ["🎨"];
        const format =
          (body.format as "static" | "animated" | "video") ?? "static";
        if (!userId || !name || !filePath) {
          return { ok: false, error: "Required: user_id, name, file_path" };
        }
        const data = readFileSync(filePath);
        const sticker = {
          sticker: new InputFileClass(data, basename(filePath)),
          format,
          emoji_list: emojis,
        };
        await bot.api.addStickerToSet(userId, name, sticker);
        return { ok: true, text: `Added sticker to pack "${name}".` };
      }

      case "delete_sticker_from_set": {
        const stickerId = String(body.sticker_file_id ?? "");
        if (!stickerId)
          return { ok: false, error: "Required: sticker_file_id" };
        await bot.api.deleteStickerFromSet(stickerId);
        return { ok: true, text: "Sticker deleted from pack." };
      }

      case "set_sticker_set_title": {
        const name = String(body.name ?? "");
        const title = String(body.title ?? "");
        if (!name || !title)
          return { ok: false, error: "Required: name, title" };
        await bot.api.setStickerSetTitle(name, title);
        return { ok: true, text: `Pack title updated to "${title}".` };
      }

      case "delete_sticker_set": {
        const name = String(body.name ?? "");
        if (!name) return { ok: false, error: "Required: name" };
        await bot.api.deleteStickerSet(name);
        return { ok: true, text: `Deleted sticker pack "${name}".` };
      }

      case "stop_poll": {
        const msgId = Number(body.message_id);
        if (!msgId) return { ok: false, error: "Required: message_id" };
        const poll = await bot.api.stopPoll(chatId, msgId);
        const results = poll.options
          .map(
            (o) =>
              `  ${o.text}: ${o.voter_count} vote${o.voter_count === 1 ? "" : "s"}`,
          )
          .join("\n");
        return {
          ok: true,
          text: `Poll closed: "${poll.question}"\nTotal voters: ${poll.total_voter_count}\n\nResults:\n${results}`,
        };
      }

      case "download_media": {
        if (isUserClientReady()) {
          const { downloadMessageMedia } = await import("./userbot.js");
          return {
            ok: true,
            text: await downloadMessageMedia({
              chatId,
              messageId: Number(body.message_id),
            }),
          };
        }
        return { ok: false, error: "User client not connected." };
      }

      default:
        return null; // not a Telegram action
    }
  };
}
