/**
 * `/memory` — a read-only window on the typed memory store.
 *
 * Four shapes, all reads: the ranked listing, a full-text search, one
 * row's provenance (`why <id>`) and a per-kind listing. Nothing here
 * writes: asserting, superseding and dropping are the write path's job
 * (rollout PR 6), so the operator can always ask what Talon remembers
 * without the answer being able to change it.
 *
 * Admin only, and only in a private chat. The store holds the operator's
 * private notes — people, places, health, relationships — so a read of it
 * is not a low-privilege action: in a group every member would see the
 * reply, and anyone else who can reach the bot must not see it at all.
 *
 * Every line is model- or user-authored text reaching an HTML-parsed
 * send, so it goes through `escapeHtml` before it is joined; the reply
 * is chunked because a listing of 15 rows can outgrow Telegram's
 * 4096-char cap on its own.
 */

import type { Bot, Context } from "grammy";
import { escapeHtml } from "../formatting.js";
import { replyHtmlChunked } from "../admin/chunked-reply.js";
import { isAuthorizedAdmin } from "./state.js";
import {
  formatMemory,
  getMemory,
  isMemoryKind,
  listMemories,
  memoryHistory,
  searchMemories,
  MEMORY_KINDS,
  type MemoryRow,
} from "../../../storage/memory.js";

/** Rows per reply — a chat listing is a glance, not an export. */
const LIST_LIMIT = 15;

export function registerMemoryCommand(bot: Bot): void {
  bot.command("memory", async (ctx: Context) => {
    const verdict = memoryAccess(ctx);
    if (verdict !== "ok") {
      await ctx.reply(
        verdict === "not-private"
          ? "Memory is private — ask me in a DM."
          : "Not authorized.",
      );
      return;
    }
    const arg = (ctx.match ?? "").toString().trim();
    await replyHtmlChunked(ctx, renderMemory(arg));
  });
}

/**
 * Who may read memory here: the admin, in a private chat.
 * Order matters — a non-admin in a group gets "not authorized", not
 * a hint that a DM would work.
 */
function memoryAccess(ctx: Context): "ok" | "not-admin" | "not-private" {
  if (!isAuthorizedAdmin(ctx)) return "not-admin";
  if (ctx.chat?.type !== "private") return "not-private";
  return "ok";
}

/** Route the argument to one of the four reads. Returns ready HTML. */
function renderMemory(arg: string): string {
  const why = /^why\b\s*(.*)$/is.exec(arg);
  if (why) return renderWhy(why[1]!.trim());
  const kind = /^kind\b\s*(.*)$/is.exec(arg);
  if (kind) return renderKind(kind[1]!.trim());
  if (!arg)
    return renderRows(
      listMemories({ limit: LIST_LIMIT }),
      "Nothing remembered yet.",
    );
  return renderRows(
    searchMemories(arg, { limit: LIST_LIMIT }),
    `No memories matching "${arg}".`,
  );
}

/** One escaped line per row, or the (escaped) empty-case sentence. */
function renderRows(rows: MemoryRow[], empty: string): string {
  if (rows.length === 0) return escapeHtml(empty);
  return rows.map((row) => escapeHtml(formatMemory(row))).join("\n");
}

function renderKind(kind: string): string {
  if (!isMemoryKind(kind))
    return escapeHtml(
      `No such kind "${kind}". Valid kinds: ${MEMORY_KINDS.join(", ")}.`,
    );
  return renderRows(
    listMemories({ kind, limit: LIST_LIMIT }),
    `Nothing remembered under ${kind}.`,
  );
}

/**
 * Provenance for one row: the row itself, the numbers that decide where
 * it ranks, and its audit trail. Reads by id rather than by the live
 * listing, so a superseded or dropped row still explains itself.
 */
function renderWhy(raw: string): string {
  const id = Number(raw);
  if (!raw || !Number.isInteger(id))
    return escapeHtml(`No memory with id ${raw || "(none given)"}.`);
  const row = getMemory(id);
  if (!row) return escapeHtml(`No memory with id ${id}.`);
  const lines = [
    escapeHtml(formatMemory(row)),
    "",
    escapeHtml(
      `trust ${row.trust} · confidence ${row.confidence} · hits ${row.hitCount} · salience ${row.salience}`,
    ),
    escapeHtml(
      `created ${isoTime(row.createdAt)} · last seen ${isoTime(row.lastSeenAt)}`,
    ),
  ];
  const history = memoryHistory(row.id);
  if (history.length > 0) {
    lines.push("", "<b>History</b>");
    for (const entry of history) {
      const reason = entry.reason ? ` — ${entry.reason}` : "";
      lines.push(escapeHtml(`${isoTime(entry.at)} ${entry.op}${reason}`));
    }
  }
  return lines.join("\n");
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}
