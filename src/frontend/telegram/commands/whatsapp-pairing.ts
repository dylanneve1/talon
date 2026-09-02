/**
 * /whatsapp — drive WhatsApp device pairing from Telegram.
 *
 * `/whatsapp` reports link state; `/whatsapp pair` runs ONE bounded
 * pairing attempt via the core pairing broker and replies with the QR as
 * a photo (plus the phone-number code when the account has one
 * configured). The human runs it when they are holding the phone —
 * pairing is never automatic, because automatic retries are how the
 * account got rate-limited into "couldn't connect device".
 */

import { InputFile, type Bot } from "grammy";
import { getPairingProvider } from "../../../core/pairing-broker.js";
import { log } from "../../../util/log.js";
import { isAuthorizedAdmin } from "./state.js";

export function registerWhatsAppPairingCommand(bot: Bot): void {
  bot.command("whatsapp", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }

    const provider = getPairingProvider();
    if (!provider) {
      await ctx.reply(
        'WhatsApp isn\'t enabled on this daemon — add "whatsapp" to the ' +
          "frontend list and configure the whatsapp block, then restart.",
      );
      return;
    }

    const arg = (ctx.match ?? "").trim().toLowerCase();
    if (arg !== "pair") {
      await ctx.reply(
        provider.isLinked()
          ? "✅ WhatsApp is linked and connected.\nSend /whatsapp pair to re-link."
          : "📴 WhatsApp is not linked.\nSend /whatsapp pair when you're " +
              "holding the phone — I'll reply with a QR to scan " +
              "(WhatsApp → Linked devices → Link a device).",
      );
      return;
    }

    if (provider.isLinked()) {
      await ctx.reply(
        "WhatsApp is already linked. Unlink it on the phone first if you " +
          "want to re-pair.",
      );
      return;
    }

    let attempt;
    try {
      attempt = await provider.begin();
    } catch (err) {
      await ctx.reply(
        `Couldn't start pairing: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }

    if (attempt.qrPng) {
      const codeLine = attempt.code
        ? `\nOr enter code: ${attempt.code} (Link with phone number instead)`
        : "";
      await ctx.replyWithPhoto(
        new InputFile(attempt.qrPng, "whatsapp-qr.png"),
        {
          caption:
            "Scan within ~2 minutes:\n" +
            "WhatsApp → ⋮ → Linked devices → Link a device" +
            codeLine,
        },
      );
    } else {
      await ctx.reply(
        "No QR came back — WhatsApp may still be rate-limiting. Try later.",
      );
    }

    const outcome = await attempt.result;
    if (outcome.ok) {
      log("bot", `WhatsApp paired via /whatsapp pair (${outcome.identity})`);
      await ctx.reply(
        `✅ Linked as ${outcome.identity}. WhatsApp is connecting now.`,
      );
    } else if (outcome.reason === "expired") {
      await ctx.reply(
        "⌛ That window expired without a successful scan. Run " +
          "/whatsapp pair again when you're ready — if the phone says " +
          '"couldn\'t connect device", WhatsApp is still rate-limiting; ' +
          "wait an hour and try once more.",
      );
    } else if (outcome.reason !== "cancelled") {
      await ctx.reply(
        `❌ Pairing failed${outcome.detail ? `: ${outcome.detail}` : ""}. ` +
          "Run /whatsapp pair to try again.",
      );
    }
  });
}
