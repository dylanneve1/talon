/**
 * Admin + maintenance commands — /admin, /metrics, /doctor, /dream, /soul,
 * /restart, /update — plus the unknown-command "did you mean…?" suggester.
 *
 * Most commands here gate on the configured admin user id via
 * `isAuthorizedAdmin`.
 */

import type { Bot } from "grammy";
import { respawnSelf } from "../../../util/respawn.js";
import {
  getRepoRoot,
  runSelfUpdate,
} from "../../../core/update/self-update.js";
import { forceDream } from "../../../core/background/dream.js";
import { getSoul } from "../../../core/soul/service.js";
import { escapeHtml } from "../formatting.js";
import { closestMatch } from "../../../native/strsim.js";
import {
  formatDuration,
  renderDoctorMessage,
  renderMetricsKeyboard,
  renderMetricsPanel,
  renderUsageMessage,
} from "../helpers/index.js";
import { collectPlanUsage } from "../../shared/plan-usage-report.js";
import { collectDoctorReport } from "../../../core/doctor.js";
import { handleAdminCommand } from "../admin.js";
import { getTodayMetrics } from "../../../storage/metrics.js";
import { isAuthorizedAdmin, type RegisterDeps } from "./state.js";
import { telegramCommandMenu } from "./definitions.js";

export function registerAdminCommands(
  bot: Bot,
  { config }: RegisterDeps,
): void {
  bot.command("admin", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    await handleAdminCommand(ctx, bot, config);
  });

  bot.command("metrics", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    // One message, two grains. Today opens first — it is the smaller,
    // more actionable view; All time is a tap away on the same message.
    await ctx.reply(renderMetricsPanel(getTodayMetrics(), "today"), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: renderMetricsKeyboard("today") },
    });
  });

  // /usage — plan limits across every exposed backend, not just this
  // chat's. Not admin-gated: it says how close the shared account is to a
  // wall, which is exactly what a user hitting one needs to know.
  bot.command("usage", async (ctx) => {
    const entries = await collectPlanUsage(config);
    await ctx.reply(renderUsageMessage(entries), { parse_mode: "HTML" });
  });

  bot.command("doctor", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const sent = await ctx.reply("🩺 Running checks...");
    try {
      // Same checks as `talon doctor` — config exists by definition
      // when the bot is processing this command.
      const report = await collectDoctorReport({ config, hasConfigFile: true });
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        renderDoctorMessage(report),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await bot.api.editMessageText(
        ctx.chat.id,
        sent.message_id,
        `🩺 Doctor failed: ${escapeHtml(msg)}`,
        { parse_mode: "HTML" },
      );
    }
  });

  bot.command("dream", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const sent = await ctx.reply("🌙 Dream mode starting...");
    const start = Date.now();
    // Fire-and-forget — don't await, so grammY can keep processing other updates
    forceDream()
      .then(async () => {
        const elapsed = formatDuration(Date.now() - start);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream complete — memory consolidated in ${elapsed}.`,
        );
      })
      .catch(async (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        await bot.api.editMessageText(
          ctx.chat.id,
          sent.message_id,
          `🌙 Dream failed: ${escapeHtml(msg)}`,
          { parse_mode: "HTML" },
        );
      });
  });

  // /soul — introspect the compiled identity (read-only). `/soul dream`
  // (admin) runs the organic maintenance pass. Inert when the soul is
  // disabled (TALON_SOUL_ENABLED), so it's safe to ship dormant.
  bot.command("soul", async (ctx) => {
    const soul = getSoul();
    if (!soul.enabled) {
      await ctx.reply("Soul is disabled (set TALON_SOUL_ENABLED to enable).");
      return;
    }
    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg === "dream") {
      if (!isAuthorizedAdmin(ctx)) {
        await ctx.reply("Not authorized.");
        return;
      }
      const sent = await ctx.reply("🧠 Soul dreaming...");
      void soul
        .dream()
        .then(() =>
          bot.api.editMessageText(
            ctx.chat.id,
            sent.message_id,
            "🧠 Soul dream complete.",
          ),
        )
        .catch(() => undefined);
      return;
    }
    await ctx.reply(soul.introspect());
  });

  bot.command("restart", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    await ctx.reply("♻️ Restarting...");
    respawnSelf("telegram /restart");
  });

  // /update — pull latest, reinstall, run setup, restart. Only wired
  // up for developer builds running from a git checkout; packaged
  // binaries have no source tree (getRepoRoot() === null) so the
  // command stays absent entirely.
  const updateRepoRoot = config.devBuild ? getRepoRoot() : null;
  if (updateRepoRoot) {
    bot.command("update", async (ctx) => {
      if (!isAuthorizedAdmin(ctx)) {
        await ctx.reply("Not authorized.");
        return;
      }
      const remote = config.update?.remote ?? "origin";
      const branch = config.update?.branch ?? "main";
      const sent = await ctx.reply(
        `⏳ Updating from <code>${escapeHtml(remote)}/${escapeHtml(branch)}</code>…`,
        { parse_mode: "HTML" },
      );
      const edit = (text: string) =>
        bot.api
          .editMessageText(ctx.chat.id, sent.message_id, text, {
            parse_mode: "HTML",
          })
          .catch(() => {});

      // Fire-and-forget so grammY keeps processing other updates.
      runSelfUpdate({
        remote,
        branch,
        setup: config.update?.setup,
        repoRoot: updateRepoRoot,
      })
        .then(async (res) => {
          if (!res.ok) {
            const tail = res.steps[res.steps.length - 1]?.output ?? "";
            await edit(
              `⚠️ Update failed: ${escapeHtml(res.error ?? "unknown error")}` +
                (tail ? `\n\n<pre>${escapeHtml(tail.slice(-1500))}</pre>` : ""),
            );
            return;
          }
          if (!res.changed) {
            await edit(
              `✅ Already up to date at <code>${escapeHtml(res.before ?? "?")}</code> — no restart needed.`,
            );
            return;
          }
          await edit(
            `✅ Updated <code>${escapeHtml(res.before ?? "?")}</code> → <code>${escapeHtml(res.after ?? "?")}</code>. ♻️ Restarting…`,
          );
          respawnSelf("telegram /update");
        })
        .catch(async (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          await edit(`⚠️ Update crashed: ${escapeHtml(msg)}`);
        });
    });
  }

  // Unknown /command → "did you mean ...?" via the C similarity core
  // (native/strsim-wasm). Registered after every real command, so grammY
  // only reaches this when nothing above matched. Only bare commands
  // are intercepted — a close miss gets a suggestion, anything else
  // keeps flowing to the agent as a normal message.
  const commandNames = telegramCommandMenu(config).map((c) => c.command);
  bot.on("message::bot_command", async (ctx, next) => {
    const typed = /^\/([a-zA-Z0-9_]+)(?:@(\w+))?\s*$/.exec(ctx.msg.text ?? "");
    if (!typed) return next();
    const [, name, mention] = typed;
    // In groups a command can be addressed to another bot — not ours
    // to answer.
    if (mention && mention.toLowerCase() !== ctx.me.username.toLowerCase()) {
      return next();
    }
    const suggestion = closestMatch(name.toLowerCase(), commandNames);
    if (!suggestion) return next();
    await ctx.reply(
      `Unknown command /${name} — did you mean /${suggestion.value}?`,
    );
  });
}
