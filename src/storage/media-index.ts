/**
 * Media index — tracks downloaded media files with metadata and expiry.
 *
 * Provides fast lookup of recent photos/files by chat, sender, or type.
 * Auto-expires entries older than RETENTION_DAYS.
 * Persisted to .talon/data/media-index.json.
 */

import { existsSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { registerCleanup } from "../util/cleanup-registry.js";
import writeFileAtomic from "write-file-atomic";
import { log, logError } from "../util/log.js";
import { files } from "../util/paths.js";

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

const STORE_FILE = files.mediaIndex;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let entries: MediaEntry[] = [];
let dirty = false;

// ── Persistence ─────────────────────────────────────────────────────────────

export function loadMediaIndex(): void {
  try {
    if (existsSync(STORE_FILE)) {
      entries = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
    }
  } catch {
    entries = [];
  }
  // Purge expired on load
  purgeExpired();
}

function save(): void {
  if (!dirty) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomic.sync(STORE_FILE, JSON.stringify(entries) + "\n");
    dirty = false;
  } catch (err) {
    logError("workspace", "Media index save failed", err);
  }
}

const autoSaveTimer = setInterval(save, 30_000);
registerCleanup(save);

export function flushMediaIndex(): void {
  clearInterval(autoSaveTimer);
  dirty = true;
  save();
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addMedia(entry: Omit<MediaEntry, "id">): void {
  const id = `${entry.chatId}:${entry.msgId}`;
  // Dedupe
  const existing = entries.findIndex((e) => e.id === id);
  if (existing >= 0) entries[existing] = { ...entry, id };
  else entries.push({ ...entry, id });
  dirty = true;
}

/** Get recent media for a chat, newest first. */
export function getRecentMedia(chatId: string, limit = 10): MediaEntry[] {
  return entries
    .filter((e) => e.chatId === chatId)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

/** Get all media matching a type in a chat. */
export function getMediaByType(
  chatId: string,
  type: MediaEntry["type"],
  limit = 10,
): MediaEntry[] {
  return entries
    .filter((e) => e.chatId === chatId && e.type === type)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
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
  const before = entries.length;
  entries = entries.filter((e) => {
    if (e.timestamp >= cutoff) return true;
    // Delete the file too
    try {
      if (existsSync(e.filePath)) unlinkSync(e.filePath);
    } catch {
      /* skip */
    }
    return false;
  });
  if (entries.length < before) {
    dirty = true;
    log("workspace", `Purged ${before - entries.length} expired media entries`);
  }
}
