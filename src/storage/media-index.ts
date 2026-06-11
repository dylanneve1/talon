/**
 * Media index — tracks downloaded media files with metadata and expiry.
 *
 * Provides fast lookup of recent photos/files by chat, sender, or type.
 * Auto-expires entries older than RETENTION_MS.
 *
 * Backed by SQLite (see repositories/media-index-repo.ts for the
 * statements; this module holds the domain API, formatting and the
 * expiry sweep's file deletion — no SQL here). Reads are indexed
 * queries instead of in-memory scans, writes are per-row commits
 * instead of a 30s autosave timer rewriting the whole file.
 *
 * The legacy ~/.talon/data/media-index.json (JsonStore envelope or
 * bare pre-envelope array) is imported once on first load, then
 * renamed to media-index.json.imported.
 */

import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { log, logError } from "../util/log.js";
import { files } from "../util/paths.js";
import * as repo from "./repositories/media-index-repo.js";

export type MediaEntry = {
  id: string; // unique key: chatId:msgId
  chatId: string;
  msgId: number;
  senderName: string;
  type:
    | "photo"
    | "document"
    | "voice"
    | "video"
    | "animation"
    | "audio"
    | "sticker";
  filePath: string;
  caption?: string;
  timestamp: number;
};

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isMediaEntry(value: unknown): value is MediaEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.chatId === "string" &&
    typeof e.msgId === "number" &&
    typeof e.senderName === "string" &&
    typeof e.type === "string" &&
    typeof e.filePath === "string" &&
    typeof e.timestamp === "number"
  );
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * Run the one-time import of the legacy JSON store, then sweep
 * expired entries. Idempotent; called once at boot.
 */
export function loadMediaIndex(): void {
  try {
    importLegacyJson();
  } catch (err) {
    logError("workspace", "Media index load failed", err);
  }
  purgeExpired();
}

/**
 * Legacy JsonStore envelope ({schemaVersion, savedAt, data}) or the
 * even older bare MediaEntry[] shape.
 */
function importLegacyJson(): void {
  // Test isolation: suites that don't mock HOME would otherwise rename
  // the user's REAL legacy JSON during import (observed live). The
  // vitest setup sets this; import-testing suites unset it locally.
  if (process.env.TALON_DISABLE_LEGACY_IMPORT === "1") return;
  const legacyPath = files.mediaIndex;
  if (!existsSync(legacyPath)) return;
  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as unknown;
    const data =
      raw && typeof raw === "object" && !Array.isArray(raw) && "data" in raw
        ? (raw as { data: unknown }).data
        : raw;
    const entries = Array.isArray(data) ? data.filter(isMediaEntry) : [];
    const imported = repo.upsertMany(entries);
    renameSync(legacyPath, `${legacyPath}.imported`);
    log(
      "workspace",
      `Imported ${imported} media entr(ies) from legacy media-index.json into SQLite`,
    );
  } catch (err) {
    logError("workspace", "Legacy media-index import failed", err);
  }
}

/**
 * SQLite commits on every write — there is no dirty buffer to flush.
 * Kept for the shutdown path: compacts the WAL into the main file.
 */
export function flushMediaIndex(): void {
  try {
    repo.checkpoint();
  } catch {
    /* shutting down — best effort */
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addMedia(entry: Omit<MediaEntry, "id">): void {
  try {
    repo.upsert(entry);
  } catch (err) {
    logError("workspace", "Media index save failed", err);
  }
}

/** Get recent media for a chat, newest first. */
export function getRecentMedia(chatId: string, limit = 10): MediaEntry[] {
  return repo.recentByChat(chatId, limit);
}

/** Get all media matching a type in a chat. */
export function getMediaByType(
  chatId: string,
  type: MediaEntry["type"],
  limit = 10,
): MediaEntry[] {
  return repo.byType(chatId, type, limit);
}

/** Format media index as text for Claude. */
export function formatMediaIndex(chatId: string, limit = 10): string {
  const media = getRecentMedia(chatId, limit);
  if (media.length === 0) return "No recent media in this chat.";
  return media
    .map((m) => {
      const time = new Date(m.timestamp)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      const cap = m.caption ? ` "${m.caption.slice(0, 50)}"` : "";
      return `[${m.type}] msg:${m.msgId} by ${m.senderName} at ${time}${cap}\n  file: ${m.filePath}`;
    })
    .join("\n");
}

// ── Expiry ──────────────────────────────────────────────────────────────────

function purgeExpired(): void {
  const cutoff = Date.now() - RETENTION_MS;
  try {
    const expired = repo.olderThan(cutoff);
    for (const e of expired) {
      try {
        if (existsSync(e.filePath)) unlinkSync(e.filePath);
      } catch {
        /* skip */
      }
    }
    const removed = repo.deleteOlderThan(cutoff);
    if (removed > 0) {
      log("workspace", `Purged ${removed} expired media entries`);
    }
  } catch (err) {
    logError("workspace", "Media index purge failed", err);
  }
}
