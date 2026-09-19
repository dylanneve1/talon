/**
 * `backup:*` callbacks — the /backup restore confirmation.
 *
 *   backup:restore:<id>  stage the restore and restart
 *   backup:cancel        do nothing, say so
 *
 * The button is the whole safety mechanism: a restore replaces the
 * database, the memory and the identity of a running agent, so nothing
 * here happens without a second, explicit admin tap.
 */

import type { Context } from "grammy";
import { isSnapshotId } from "../../../core/backup/index.js";
import { stageRestore } from "../commands/backup.js";
import { isAuthorizedAdmin } from "../commands/state.js";
import { logError } from "../../../util/log.js";
import { answerCallbackQuerySafe } from "./query.js";

export async function handleBackupCallback(
  ctx: Context,
  data: string,
): Promise<void> {
  if (!isAuthorizedAdmin(ctx)) {
    await answerCallbackQuerySafe(ctx, { text: "Not authorized." });
    return;
  }
  const [, action, id] = data.split(":");
  if (action === "cancel") {
    await answerCallbackQuerySafe(ctx, { text: "Cancelled." });
    await ctx.editMessageText("Restore cancelled.").catch(() => {});
    return;
  }
  if (action !== "restore" || !id || !isSnapshotId(id)) {
    await answerCallbackQuerySafe(ctx, { text: "Invalid callback data" });
    return;
  }
  await answerCallbackQuerySafe(ctx, { text: "Restoring…" });
  await ctx
    .editMessageText(
      `♻️ Restoring <code>${id}</code> — restarting now. ` +
        "The restore is applied during boot; I will report back when I am up.",
      { parse_mode: "HTML" },
    )
    .catch(() => {});
  try {
    await stageRestore(String(ctx.chat?.id ?? ctx.from?.id ?? ""), id);
  } catch (err) {
    logError("backup", "Staging the restore failed", err);
    await ctx
      .editMessageText(
        `⚠️ Could not stage the restore: ${err instanceof Error ? err.message : String(err)}`,
      )
      .catch(() => {});
  }
}
