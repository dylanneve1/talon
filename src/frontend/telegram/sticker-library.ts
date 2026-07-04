/**
 * Sticker library (write side) — fetches packs from Telegram into the
 * workspace store and resolves emoji → file_id for sending.
 *
 * This is what makes stickers actually usable in conversation: the
 * model sends by *feeling* (`send(type="sticker", emoji="😂")`) and the
 * frontend resolves a concrete file_id here, instead of the model
 * having to remember a 60-char file_id or run a browse→save→read
 * round-trip first. Packs enter the library two ways: automatically
 * when a user sends a sticker from a pack we haven't seen (see
 * handlers/messages.ts), and explicitly via `save_sticker_pack`.
 *
 * Only the plain Bot API (`getStickerSet`) is needed — no userbot.
 * The read side (pack listing + the prompt index) lives in
 * `storage/sticker-store.ts`, shared with prompt assembly.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirs } from "../../util/paths.js";
import { log } from "../../util/log.js";
import {
  listSavedPacks,
  type SavedPack,
  type SavedSticker,
} from "../../storage/sticker-store.js";

// ── Types ───────────────────────────────────────────────────────────────────

/** Minimal structural slice of a grammY Bot that the library needs. */
export type StickerSetFetcher = {
  api: {
    getStickerSet: (name: string) => Promise<{
      title: string;
      name: string;
      stickers: Array<{ emoji?: string; file_id: string }>;
    }>;
  };
};

// ── Saving ──────────────────────────────────────────────────────────────────

/**
 * Fetch a pack from Telegram and write it into the library. Returns a
 * human-readable summary (also the tool-result text for
 * `save_sticker_pack`). Overwrites an existing file — re-saving
 * refreshes a pack whose contents changed upstream.
 */
export async function savePackToLibrary(
  bot: StickerSetFetcher,
  setName: string,
): Promise<string> {
  const stickerSet = await bot.api.getStickerSet(setName);
  const stickers: SavedSticker[] = stickerSet.stickers.map((s) => ({
    emoji: s.emoji ?? "",
    fileId: s.file_id,
  }));
  const packData: SavedPack = {
    name: stickerSet.name,
    title: stickerSet.title,
    count: stickers.length,
    stickers,
    savedAt: new Date().toISOString(),
  };
  const dir = dirs.stickers;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${stickerSet.name}.json`),
    JSON.stringify(packData, null, 2),
  );
  return `Saved "${stickerSet.title}" (${stickers.length} stickers) to .talon/workspace/stickers/${stickerSet.name}.json`;
}

/** Packs currently being auto-fetched — dedupes concurrent saves. */
const inFlightSaves = new Set<string>();

/**
 * Save a pack only if it isn't in the library yet. Fire-and-forget
 * safe: failures are logged, never thrown. Used by the incoming
 * sticker handler so the library grows organically from conversation.
 * Concurrent calls for the same pack (a user posting several stickers
 * in a burst) collapse into one fetch.
 */
export async function ensurePackSaved(
  bot: StickerSetFetcher,
  setName: string,
): Promise<void> {
  if (!setName) return;
  if (existsSync(resolve(dirs.stickers, `${setName}.json`))) return;
  if (inFlightSaves.has(setName)) return;
  inFlightSaves.add(setName);
  try {
    const summary = await savePackToLibrary(bot, setName);
    log("stickers", `Auto-saved pack: ${summary}`);
  } catch (err) {
    log(
      "stickers",
      `Auto-save of pack "${setName}" failed: ${err instanceof Error ? err.message : err}`,
    );
  } finally {
    inFlightSaves.delete(setName);
  }
}

// ── Emoji resolution ────────────────────────────────────────────────────────

/**
 * Normalize an emoji for matching: trim, strip variation selectors
 * (U+FE00–U+FE0F) so "❤️" (with U+FE0F) matches a pack's "❤", and strip
 * skin-tone modifiers (U+1F3FB–U+1F3FF) so "👍🏻" matches a pack's "👍".
 */
function normalizeEmoji(emoji: string): string {
  return emoji
    .trim()
    .replace(/[\uFE00-\uFE0F]/g, "")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
}

/**
 * Resolve an emoji to a concrete sticker file_id.
 *
 * Search order: the named pack when `setName` is given (fetching and
 * saving it if it isn't in the library yet, and refreshing a stale
 * library copy once when the emoji misses — packs gain stickers
 * upstream), otherwise every saved pack. Among matches, one is picked
 * at random so repeated sends don't always produce the identical
 * sticker. Returns null when nothing matches.
 */
export async function resolveStickerByEmoji(
  bot: StickerSetFetcher,
  emoji: string,
  setName?: string,
): Promise<{ fileId: string; pack: string } | null> {
  const want = normalizeEmoji(emoji);
  // A blank query must never match stickers whose emoji metadata is
  // empty — that would resolve " " to a random unrelated sticker.
  if (!want) return null;

  const findMatches = (packs: SavedPack[]) =>
    packs.flatMap((p) =>
      p.stickers
        .filter((s) => normalizeEmoji(s.emoji) === want)
        .map((s) => ({ fileId: s.fileId, pack: p.name })),
    );
  const pick = (matches: Array<{ fileId: string; pack: string }>) =>
    matches.length === 0
      ? null
      : matches[Math.floor(Math.random() * matches.length)];

  if (!setName) return pick(findMatches(listSavedPacks()));

  // Named pack: fetch on miss, and refresh a stale library copy once
  // when the emoji doesn't match — bounded to this explicit-pack path
  // so the every-pack search never triggers network calls.
  let pack = listSavedPacks().find((p) => p.name === setName);
  let justFetched = false;
  if (!pack) {
    try {
      await savePackToLibrary(bot, setName);
      justFetched = true;
      pack = listSavedPacks().find((p) => p.name === setName);
    } catch {
      return null;
    }
  }
  if (!pack) return null;
  let matches = findMatches([pack]);
  if (matches.length === 0 && !justFetched) {
    try {
      await savePackToLibrary(bot, setName);
      const refreshed = listSavedPacks().find((p) => p.name === setName);
      if (refreshed) matches = findMatches([refreshed]);
    } catch {
      /* keep the miss — the stale copy already said no */
    }
  }
  return pick(matches);
}
