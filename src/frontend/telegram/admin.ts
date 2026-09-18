/**
 * Admin command handlers — /admin subcommands for bot operators.
 *
 * The table maps each subcommand to its handler in `admin/`:
 *   - `sessions`   — chats / broadcast / kill
 *   - `health`     — stats / errors / logs / daily
 *   - `background` — cron / pulse
 * Anything else (including no subcommand) gets the usage listing.
 */

import type { Bot, Context } from "grammy";
import type { TalonConfig } from "../../core/config/index.js";
import { replyActiveChats, broadcast, killSession } from "./admin/sessions.js";
import {
  replyStats,
  replyRecentErrors,
  replyLogTail,
  replyDailyLog,
} from "./admin/health.js";
import { replyCronJobs, replyPulseStatus } from "./admin/background.js";

type AdminSubcommand = (
  ctx: Context,
  rest: string[],
  bot: Bot,
  config: TalonConfig,
) => Promise<void>;

// Null-prototype so `/admin constructor` can't resolve an inherited
// Object.prototype method via `handlers[subcommand]`.
const ADMIN_SUBCOMMANDS: Record<string, AdminSubcommand> = Object.assign(
  Object.create(null),
  {
    chats: replyActiveChats,
    broadcast,
    kill: killSession,
    logs: replyLogTail,
    stats: replyStats,
    errors: replyRecentErrors,
    cron: replyCronJobs,
    pulse: replyPulseStatus,
    daily: replyDailyLog,
  } satisfies Record<string, AdminSubcommand>,
);

async function replyUsage(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "<b>/admin commands</b>",
      "",
      "  stats    uptime, messages, memory",
      "  errors   last 5 errors",
      "  chats    list all active chats",
      "  daily    today's interaction log",
      "  pulse    pulse status per chat",
      "  cron     list all cron jobs",
      "  broadcast &lt;text&gt;  send to all chats",
      "  kill &lt;chatId&gt;     reset a chat session",
      "  logs     last 20 lines of log",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

export async function handleAdminCommand(
  ctx: Context,
  bot: Bot,
  config: TalonConfig,
): Promise<void> {
  const args = ((ctx.match as string) ?? "").trim();
  const [subcommand, ...rest] = args.split(/\s+/);
  const run = ADMIN_SUBCOMMANDS[subcommand];
  if (!run) {
    await replyUsage(ctx);
    return;
  }
  await run(ctx, rest, bot, config);
}
