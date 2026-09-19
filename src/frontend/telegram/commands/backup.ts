/**
 * /backup — the snapshot panel (admin only).
 *
 *   /backup                    status: schedule, sizes, targets
 *   /backup now                take a snapshot now
 *   /backup checkpoint <label> take a labelled, pinned-on-request snapshot
 *   /backup list               recent snapshots
 *   /backup pin|unpin <id>     keep past retention, or release
 *   /backup restore <id>       confirm button → staged restore + restart
 *
 * Restore is the only destructive one, so it is the only one behind a
 * button. It does not restore in place: a running daemon holds the
 * database it would replace, so the request is staged to
 * ~/.talon/restore-pending.json and applied by the next boot before
 * anything opens the database (see core/backup/restore.ts).
 */

import type { Bot, Context } from "grammy";
import {
  collectBackupStatus,
  formatBackupStatus,
  formatSnapshotList,
  isSnapshotId,
  listSnapshots,
  readManifest,
  runBackup,
  setSnapshotPinned,
  writeRestorePending,
} from "../../../core/backup/index.js";
import { respawnSelf } from "../../../core/daemon/respawn.js";
import { escapeHtml } from "../formatting.js";
import { logError } from "../../../util/log.js";
import { isAuthorizedAdmin } from "./state.js";

const HELP = [
  "<b>/backup</b> — snapshots and checkpoints",
  "",
  "<code>/backup</code> — status",
  "<code>/backup now</code> — take a snapshot",
  "<code>/backup checkpoint &lt;label&gt;</code> — labelled checkpoint",
  "<code>/backup list</code> — recent snapshots",
  "<code>/backup pin &lt;id&gt;</code> · <code>/backup unpin &lt;id&gt;</code>",
  "<code>/backup restore &lt;id&gt;</code> — restore (asks to confirm, then restarts)",
].join("\n");

function pre(text: string): string {
  return `<pre>${escapeHtml(text)}</pre>`;
}

async function sendStatus(ctx: Context): Promise<void> {
  const status = await collectBackupStatus();
  await ctx.reply(pre(formatBackupStatus(status)), { parse_mode: "HTML" });
}

async function sendList(ctx: Context): Promise<void> {
  const snapshots = await listSnapshots();
  await ctx.reply(pre(formatSnapshotList(snapshots)), { parse_mode: "HTML" });
}

async function takeSnapshot(ctx: Context, label?: string): Promise<void> {
  const sent = await ctx.reply(
    label
      ? `📸 Taking checkpoint “${escapeHtml(label)}”…`
      : "📸 Taking a snapshot…",
    { parse_mode: "HTML" },
  );
  try {
    const manifest = await runBackup({
      kind: label ? "checkpoint" : "backup",
      label,
      pinned: Boolean(label),
      trigger: "command",
    });
    await ctx.api.editMessageText(
      ctx.chat!.id,
      sent.message_id,
      `✅ <code>${escapeHtml(manifest.id)}</code> — ${manifest.parts.length} part(s), ` +
        `${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB` +
        (label ? " (pinned)" : ""),
      { parse_mode: "HTML" },
    );
  } catch (err) {
    logError("backup", "/backup now failed", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      sent.message_id,
      `⚠️ Backup failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
      { parse_mode: "HTML" },
    );
  }
}

async function setPinned(
  ctx: Context,
  id: string,
  pinned: boolean,
): Promise<void> {
  if (!isSnapshotId(id)) {
    await ctx.reply("That is not a snapshot id.");
    return;
  }
  const ok = await setSnapshotPinned(id, pinned);
  await ctx.reply(
    ok
      ? `${pinned ? "📌 Pinned" : "Unpinned"} <code>${escapeHtml(id)}</code>`
      : `No snapshot <code>${escapeHtml(id)}</code>`,
    { parse_mode: "HTML" },
  );
}

/** The confirmation prompt. The button carries the id; nothing happens yet. */
async function askToRestore(ctx: Context, id: string): Promise<void> {
  if (!isSnapshotId(id)) {
    await ctx.reply("That is not a snapshot id.");
    return;
  }
  const manifest = await readManifest(id);
  if (!manifest) {
    await ctx.reply(
      `No snapshot <code>${escapeHtml(id)}</code> on this machine.`,
      {
        parse_mode: "HTML",
      },
    );
    return;
  }
  await ctx.reply(
    `♻️ <b>Restore <code>${escapeHtml(id)}</code>?</b>\n` +
      (manifest.label ? `“${escapeHtml(manifest.label)}”\n` : "") +
      `Taken ${new Date(manifest.createdAt).toISOString()}\n\n` +
      "This replaces config, prompts, keys, sessions, the database and memory, " +
      "then restarts. A pinned checkpoint of the current state is taken first.",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "♻️ Restore and restart",
              callback_data: `backup:restore:${id}`,
            },
            { text: "Cancel", callback_data: "backup:cancel" },
          ],
        ],
      },
    },
  );
}

/**
 * Stage the restore and hand off to the successor. Called by the
 * confirmation button — see callbacks/backup.ts.
 */
export async function stageRestore(chatId: string, id: string): Promise<void> {
  await writeRestorePending({
    id,
    requestedAt: Date.now(),
    requestedBy: chatId,
  });
  respawnSelf(`telegram /backup restore ${id}`);
}

export function registerBackupCommand(bot: Bot): void {
  bot.command("backup", async (ctx) => {
    if (!isAuthorizedAdmin(ctx)) {
      await ctx.reply("Not authorized.");
      return;
    }
    const [subcommand, ...rest] = (ctx.match ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    switch (subcommand) {
      case undefined:
      case "status":
        await sendStatus(ctx);
        return;
      case "now":
        await takeSnapshot(ctx);
        return;
      case "checkpoint": {
        const label = rest.join(" ").trim();
        if (!label) {
          await ctx.reply(
            "Give the checkpoint a label: <code>/backup checkpoint before the rewrite</code>",
            {
              parse_mode: "HTML",
            },
          );
          return;
        }
        await takeSnapshot(ctx, label);
        return;
      }
      case "list":
        await sendList(ctx);
        return;
      case "pin":
      case "unpin":
        await setPinned(ctx, rest[0] ?? "", subcommand === "pin");
        return;
      case "restore":
        await askToRestore(ctx, rest[0] ?? "");
        return;
      default:
        await ctx.reply(HELP, { parse_mode: "HTML" });
    }
  });
}
