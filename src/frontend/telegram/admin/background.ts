/**
 * `/admin cron` / `pulse` — the background-job subcommands.
 */

import type { Bot, Context } from "grammy";
import { escapeHtml } from "../formatting.js";
import {
  getAllCronJobs,
  describeSchedule,
  nextRunAt,
} from "../../../storage/cron.js";
import { getPulseStatus } from "../../../core/background/pulse/pulse.js";
import { replyHtmlChunked } from "./chunked-reply.js";

export async function replyCronJobs(ctx: Context): Promise<void> {
  const jobs = getAllCronJobs();
  if (jobs.length === 0) {
    await ctx.reply("No cron jobs.");
    return;
  }
  const lines = jobs.map((j) => {
    const nextMs = nextRunAt(j);
    const last = j.lastRunAt
      ? new Date(j.lastRunAt).toISOString().slice(0, 16).replace("T", " ")
      : "never";
    const next = nextMs
      ? new Date(nextMs).toISOString().slice(0, 16).replace("T", " ")
      : "?";
    return `${j.enabled ? "✓" : "✗"} <b>${escapeHtml(j.name)}</b>\n  <code>${escapeHtml(describeSchedule(j))}</code> | ${j.type} | runs: ${j.runCount} | last: ${last} | next: ${next}`;
  });
  await replyHtmlChunked(
    ctx,
    `<b>Cron Jobs (${jobs.length})</b>\n\n` + lines.join("\n\n"),
  );
}

export async function replyPulseStatus(
  ctx: Context,
  _rest: string[],
  bot: Bot,
): Promise<void> {
  const chats = getPulseStatus();
  if (chats.length === 0) {
    await ctx.reply("No pulse chats.");
    return;
  }
  const lines = await Promise.all(
    chats.map(async (p) => {
      let title = p.chatId;
      try {
        const id = parseInt(p.chatId, 10);
        if (!isNaN(id)) {
          const chat = await bot.api.getChat(id);
          title = "title" in chat ? (chat.title ?? p.chatId) : p.chatId;
        }
      } catch {
        /* skip */
      }
      return `${p.enabled ? "✓" : "✗"} ${escapeHtml(title)}`;
    }),
  );
  await replyHtmlChunked(
    ctx,
    `<b>Pulse (${chats.length})</b>\n\n` + lines.join("\n"),
  );
}
