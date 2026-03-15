/**
 * Bridge action handlers — processes Telegram actions dispatched by the MCP tools server.
 * Grouped into logical sections: messaging, media, chat ops, history, cron.
 */

import { readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Bot, InputFile as GrammyInputFile } from "grammy";
import { markdownToTelegramHtml } from "../formatting.js";
import {
  getRecentFormatted,
  searchHistory,
  getMessagesByUser,
  getKnownUsers,
} from "../../../storage/history.js";
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
} from "../userbot.js";
import { log, logError } from "../../../util/log.js";
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
import {
  addCronJob,
  getCronJob,
  getCronJobsForChat,
  updateCronJob,
  deleteCronJob,
  validateCronExpression,
  generateCronId,
  type CronJobType,
} from "../../../storage/cron-store.js";

type BridgeAction = {
  action: string;
  [key: string]: unknown;
};

// ── Messaging actions ───────────────────────────────────────────────────────

async function handleMessaging(
  body: BridgeAction,
  bot: Bot,
  chatId: number,
): Promise<unknown> {
  switch (body.action) {
    case "send_message": {
      const text = String(body.text ?? "");
      const replyTo =
        typeof body.reply_to_message_id === "number"
          ? body.reply_to_message_id
          : undefined;
      log("bridge", `send_message${replyTo ? ` reply_to=${replyTo}` : ""}: ${text.slice(0, 80)}`);
      incrementBridgeMessageCount();
      const msgId = await withRetry(() => sendText(bot, chatId, text, replyTo));
      return { ok: true, message_id: msgId };
    }

    case "reply_to": {
      const msgId = Number(body.message_id);
      const text = String(body.text ?? "");
      log("bridge", `reply_to msg=${msgId}: ${text.slice(0, 80)}`);
      incrementBridgeMessageCount();
      const sentId = await withRetry(() => sendText(bot, chatId, text, msgId));
      return { ok: true, message_id: sentId };
    }

    case "send_message_with_buttons": {
      const text = String(body.text ?? "");
      if (text.length > TELEGRAM_MAX_TEXT) {
        return { ok: false, error: `Text too long (${text.length} chars, max ${TELEGRAM_MAX_TEXT})` };
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
            : { text: btn.text, callback_data: btn.callback_data ?? btn.text },
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
      const delaySec = Math.max(1, Math.min(3600, Number(body.delay_seconds ?? 60)));
      const scheduleId = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      log("bridge", `schedule_message: "${text.slice(0, 40)}" in ${delaySec}s`);
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

    default:
      return null;
  }
}

// ── Message operations ──────────────────────────────────────────────────────

async function handleMessageOps(
  body: BridgeAction,
  bot: Bot,
  chatId: number,
): Promise<unknown> {
  switch (body.action) {
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
      log("bridge", `edit msg=${msgId}: ${text.slice(0, 80)}`);
      const html = markdownToTelegramHtml(text);
      await withRetry(async () => {
        try {
          await bot.api.editMessageText(chatId, msgId, html, { parse_mode: "HTML" });
        } catch {
          await bot.api.editMessageText(chatId, msgId, text);
        }
      });
      return { ok: true };
    }

    case "delete_message": {
      await bot.api.deleteMessage(chatId, Number(body.message_id));
      return { ok: true };
    }

    case "pin_message": {
      await bot.api.pinChatMessage(chatId, Number(body.message_id));
      return { ok: true };
    }

    case "unpin_message": {
      const msgId = body.message_id ? Number(body.message_id) : undefined;
      await bot.api.unpinChatMessage(chatId, msgId);
      return { ok: true };
    }

    case "forward_message": {
      const msgId = Number(body.message_id);
      if (body.to_chat_id && Number(body.to_chat_id) !== chatId) {
        return { ok: false, error: "Cross-chat forwarding is not allowed." };
      }
      const sent = await bot.api.forwardMessage(chatId, chatId, msgId);
      return { ok: true, message_id: sent.message_id };
    }

    case "copy_message": {
      const sent = await bot.api.copyMessage(chatId, chatId, Number(body.message_id));
      return { ok: true, message_id: sent.message_id };
    }

    case "send_chat_action": {
      await bot.api.sendChatAction(chatId, String(body.chat_action ?? "typing") as "typing");
      return { ok: true };
    }

    default:
      return null;
  }
}

// ── Media sending ───────────────────────────────────────────────────────────

async function handleMedia(
  body: BridgeAction,
  bot: Bot,
  chatId: number,
  InputFileClass: typeof GrammyInputFile,
): Promise<unknown> {
  switch (body.action) {
    case "send_file":
    case "send_photo":
    case "send_video":
    case "send_animation":
    case "send_voice": {
      const filePath = String(body.file_path ?? "");
      const caption = body.caption ? String(body.caption) : undefined;
      log("bridge", `${body.action}: ${basename(filePath)}`);
      incrementBridgeMessageCount();

      if (body.action === "send_file") {
        const stat = statSync(filePath);
        if (stat.size > 49 * 1024 * 1024)
          return { ok: false, error: "File too large (max 49MB)" };
      }

      const data = readFileSync(filePath);
      const file = new InputFileClass(data, basename(filePath));
      const rp = replyParams(body);

      let sent;
      switch (body.action) {
        case "send_file": sent = await withRetry(() => bot.api.sendDocument(chatId, file, { caption, reply_parameters: rp })); break;
        case "send_photo": sent = await withRetry(() => bot.api.sendPhoto(chatId, file, { caption, reply_parameters: rp })); break;
        case "send_video": sent = await withRetry(() => bot.api.sendVideo(chatId, file, { caption, reply_parameters: rp })); break;
        case "send_animation": sent = await withRetry(() => bot.api.sendAnimation(chatId, file, { caption, reply_parameters: rp })); break;
        default: sent = await withRetry(() => bot.api.sendVoice(chatId, file, { caption, reply_parameters: rp })); break;
      }
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

    case "send_poll": {
      const question = String(body.question ?? "");
      const options = (body.options as string[]) ?? [];
      log("bridge", `send_poll: "${question}" (${options.length} options)`);
      incrementBridgeMessageCount();
      const sent = await bot.api.sendPoll(
        chatId, question,
        options.map((o) => ({ text: o })),
        {
          is_anonymous: body.is_anonymous as boolean | undefined,
          allows_multiple_answers: body.allows_multiple_answers as boolean | undefined,
          type: body.type as "regular" | "quiz" | undefined,
          correct_option_id: body.correct_option_id as number | undefined,
          explanation: body.explanation as string | undefined,
        },
      );
      return { ok: true, message_id: sent.message_id };
    }

    case "send_location": {
      incrementBridgeMessageCount();
      const sent = await bot.api.sendLocation(chatId, Number(body.latitude), Number(body.longitude));
      return { ok: true, message_id: sent.message_id };
    }

    case "send_contact": {
      incrementBridgeMessageCount();
      const sent = await bot.api.sendContact(
        chatId, String(body.phone_number), String(body.first_name),
        { last_name: body.last_name as string | undefined },
      );
      return { ok: true, message_id: sent.message_id };
    }

    case "send_dice": {
      const emoji = (body.emoji as string) || "\uD83C\uDFB2";
      incrementBridgeMessageCount();
      const sent = await bot.api.sendDice(chatId, emoji);
      return { ok: true, message_id: sent.message_id, value: sent.dice?.value };
    }

    default:
      return null;
  }
}

// ── Chat info ───────────────────────────────────────────────────────────────

async function handleChatInfo(
  body: BridgeAction,
  bot: Bot,
  chatId: number,
): Promise<unknown> {
  switch (body.action) {
    case "get_chat_info": {
      const chat = await bot.api.getChat(chatId);
      const count = await bot.api.getChatMemberCount(chatId).catch(() => null);
      return {
        ok: true, id: chat.id, type: chat.type,
        title: "title" in chat ? chat.title : undefined,
        member_count: count,
      };
    }

    case "get_chat_member": {
      const member = await bot.api.getChatMember(chatId, Number(body.user_id));
      return {
        ok: true, status: member.status,
        user: { id: member.user.id, first_name: member.user.first_name, username: member.user.username },
      };
    }

    case "get_chat_admins": {
      const admins = await bot.api.getChatAdministrators(chatId);
      const text = admins
        .map((a) => {
          const name = [a.user.first_name, a.user.last_name].filter(Boolean).join(" ");
          const title = "custom_title" in a && a.custom_title ? ` "${a.custom_title}"` : "";
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
      await bot.api.setChatDescription(chatId, String(body.description ?? ""));
      return { ok: true };
    }

    default:
      return null;
  }
}

// ── History & members ───────────────────────────────────────────────────────

async function handleHistory(
  body: BridgeAction,
  chatId: number,
  bot: Bot,
): Promise<unknown> {
  switch (body.action) {
    case "list_known_users": {
      if (isUserClientReady()) {
        const text = await userbotParticipantDetails({ chatId, limit: Number(body.limit ?? 50) });
        return { ok: true, text };
      }
      return { ok: true, text: getKnownUsers(String(chatId)) };
    }

    case "get_member_info": {
      if (isUserClientReady()) {
        const text = await userbotGetUserInfo({ chatId, userId: Number(body.user_id) });
        return { ok: true, text };
      }
      return { ok: false, error: "User client not connected." };
    }

    case "read_history": {
      const limit = Math.min(100, Number(body.limit ?? 30));
      if (isUserClientReady()) {
        const text = await userbotHistory({
          chatId, limit,
          offsetId: body.offset_id as number | undefined,
          before: body.before as string | undefined,
        });
        return { ok: true, text };
      }
      return { ok: true, text: getRecentFormatted(String(chatId), limit) };
    }

    case "search_history": {
      const limit = Math.min(100, Number(body.limit ?? 20));
      if (isUserClientReady()) {
        const text = await userbotSearch({ chatId, query: String(body.query ?? ""), limit });
        return { ok: true, text };
      }
      return { ok: true, text: searchHistory(String(chatId), String(body.query ?? ""), limit) };
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
      if (isUserClientReady()) {
        const text = await userbotGetMessage({ chatId, messageId: Number(body.message_id) });
        return { ok: true, text };
      }
      return { ok: false, error: "User client not connected." };
    }

    case "get_pinned_messages": {
      if (isUserClientReady()) {
        const text = await userbotPinnedMessages({ chatId });
        return { ok: true, text };
      }
      return { ok: false, error: "User client not connected." };
    }

    case "online_count": {
      if (isUserClientReady()) {
        const text = await userbotOnlineCount({ chatId });
        return { ok: true, text };
      }
      return { ok: false, error: "User client not connected." };
    }

    case "save_sticker_pack": {
      const setName = String(body.set_name ?? "");
      log("bridge", `save_sticker_pack: ${setName}`);
      const text = await userbotSaveStickerPack({ setName, bot });
      return { ok: true, text };
    }

    case "get_sticker_pack": {
      const setName = String(body.set_name ?? "");
      const stickerSet = await bot.api.getStickerSet(setName);
      const lines = stickerSet.stickers.map((s, i) => {
        const emoji = s.emoji ?? "";
        const type = s.is_animated ? "animated" : s.is_video ? "video" : "static";
        return `${i + 1}. ${emoji} [${type}] file_id: ${s.file_id}`;
      });
      const header = `Sticker pack: "${stickerSet.title}" (${stickerSet.stickers.length} stickers)\nSet name: ${stickerSet.name}`;
      return { ok: true, text: `${header}\n\n${lines.join("\n")}` };
    }

    case "download_sticker": {
      const fileId = String(body.file_id ?? "");
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
      const filePath = resolve(uploadsDir, `${Date.now()}-sticker.${ext}`);
      writeFileSync(filePath, buffer);
      return { ok: true, text: `Downloaded sticker to: ${filePath} (${buffer.length} bytes). You can view it with the Read tool.` };
    }

    case "download_media": {
      const msgId = Number(body.message_id);
      log("bridge", `download_media msg=${msgId}`);
      if (isUserClientReady()) {
        const { downloadMessageMedia } = await import("../userbot.js");
        const result = await downloadMessageMedia({ chatId, messageId: msgId });
        return { ok: true, text: result };
      }
      return { ok: false, error: "User client not connected. Media download requires user session." };
    }

    default:
      return null;
  }
}

// ── Cron job management ─────────────────────────────────────────────────────

async function handleCron(
  body: BridgeAction,
  chatId: number,
): Promise<unknown> {
  switch (body.action) {
    case "create_cron_job": {
      const name = String(body.name ?? "Unnamed job");
      const schedule = String(body.schedule ?? "");
      const jobType = (body.type as CronJobType) ?? "message";
      const content = String(body.content ?? "");
      const timezone = body.timezone ? String(body.timezone) : undefined;

      if (!schedule) return { ok: false, error: "Missing schedule expression" };
      if (!content) return { ok: false, error: "Missing content" };

      const validation = validateCronExpression(schedule, timezone);
      if (!validation.valid) {
        return { ok: false, error: `Invalid cron expression: ${validation.error}` };
      }

      const id = generateCronId();
      addCronJob({
        id, chatId: String(chatId), schedule, type: jobType, content,
        name, enabled: true, createdAt: Date.now(), runCount: 0, timezone,
      });
      log("bridge", `create_cron_job: "${name}" [${schedule}]`);
      return {
        ok: true,
        text: `Created cron job "${name}" (id: ${id})\nSchedule: ${schedule}\nType: ${jobType}\nNext run: ${validation.next ?? "unknown"}`,
      };
    }

    case "list_cron_jobs": {
      const jobs = getCronJobsForChat(String(chatId));
      if (jobs.length === 0) return { ok: true, text: "No cron jobs in this chat." };
      const lines = jobs.map((j) => {
        const status = j.enabled ? "enabled" : "disabled";
        const lastRun = j.lastRunAt
          ? new Date(j.lastRunAt).toISOString().slice(0, 16).replace("T", " ")
          : "never";
        const validation = validateCronExpression(j.schedule, j.timezone);
        const nextRun = validation.next
          ? new Date(validation.next).toISOString().slice(0, 16).replace("T", " ")
          : "unknown";
        return [
          `- ${j.name} (${status})`,
          `  ID: ${j.id}`,
          `  Schedule: ${j.schedule}${j.timezone ? ` (${j.timezone})` : ""}`,
          `  Type: ${j.type}`,
          `  Content: ${j.content.slice(0, 100)}${j.content.length > 100 ? "..." : ""}`,
          `  Runs: ${j.runCount} | Last: ${lastRun} | Next: ${nextRun}`,
        ].join("\n");
      });
      return { ok: true, text: `Cron jobs (${jobs.length}):\n\n${lines.join("\n\n")}` };
    }

    case "edit_cron_job": {
      const jobId = String(body.job_id ?? "");
      if (!jobId) return { ok: false, error: "Missing job_id" };

      const job = getCronJob(jobId);
      if (!job) return { ok: false, error: `Job ${jobId} not found` };
      if (job.chatId !== String(chatId)) {
        return { ok: false, error: "Job belongs to a different chat" };
      }

      const updates: Record<string, unknown> = {};
      if (body.name !== undefined) updates.name = String(body.name);
      if (body.content !== undefined) updates.content = String(body.content);
      if (body.enabled !== undefined) updates.enabled = Boolean(body.enabled);
      if (body.type !== undefined) updates.type = String(body.type);
      if (body.timezone !== undefined) updates.timezone = body.timezone ? String(body.timezone) : undefined;

      if (body.schedule !== undefined) {
        const newSchedule = String(body.schedule);
        const validation = validateCronExpression(newSchedule, (updates.timezone as string) ?? job.timezone);
        if (!validation.valid) {
          return { ok: false, error: `Invalid cron expression: ${validation.error}` };
        }
        updates.schedule = newSchedule;
      }

      const updated = updateCronJob(jobId, updates);
      log("bridge", `edit_cron_job: ${jobId}`);
      return {
        ok: true,
        text: `Updated job "${updated?.name ?? jobId}". Fields changed: ${Object.keys(updates).join(", ")}`,
      };
    }

    case "delete_cron_job": {
      const jobId = String(body.job_id ?? "");
      if (!jobId) return { ok: false, error: "Missing job_id" };

      const job = getCronJob(jobId);
      if (!job) return { ok: false, error: `Job ${jobId} not found` };
      if (job.chatId !== String(chatId)) {
        return { ok: false, error: "Job belongs to a different chat" };
      }

      deleteCronJob(jobId);
      log("bridge", `delete_cron_job: ${jobId} ("${job.name}")`);
      return { ok: true, text: `Deleted cron job "${job.name}" (${jobId})` };
    }

    default:
      return null;
  }
}

// ── Main dispatcher ─────────────────────────────────────────────────────────

export async function handleAction(body: BridgeAction): Promise<unknown> {
  const activeChatId = getActiveChatId();
  const botInstance = getBotInstance();
  const InputFileClass = getInputFileClass();

  if (!botInstance || !activeChatId || !InputFileClass) {
    return { ok: false, error: "No active chat context" };
  }

  try {
    const result =
      (await handleMessaging(body, botInstance, activeChatId)) ??
      (await handleMessageOps(body, botInstance, activeChatId)) ??
      (await handleMedia(body, botInstance, activeChatId, InputFileClass)) ??
      (await handleChatInfo(body, botInstance, activeChatId)) ??
      (await handleHistory(body, activeChatId, botInstance)) ??
      (await handleCron(body, activeChatId));

    if (result !== null && result !== undefined) return result;
    return { ok: false, error: `Unknown action: ${body.action}` };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError("bridge", `"${body.action}" failed: ${errMsg}`);
    return { ok: false, error: `${body.action}: ${errMsg}` };
  }
}
