/**
 * Media index — tracks downloaded media files with metadata and expiry.
 *
 * Provides fast lookup of recent photos/files by chat, sender, or type.
 * Auto-expires entries older than RETENTION_DAYS.
 *
 * Persisted to `~/.talon/data/media-index.json` via the unified
 * `JsonStore<T>` primitive: the on-disk format is the standard
 * envelope `{ schemaVersion, savedAt, data: MediaEntry[] }`. A
 * `migrate` hook accepts the pre-envelope bare-array shape so
 * existing stores load without losing entries.
 */

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { registerCleanup } from "../util/cleanup-registry.js";
import { log, logError } from "../util/log.js";
import { files } from "../util/paths.js";
import { JsonStore } from "../core/agent-runtime/store.js";

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
const SCHEMA_VERSION = 1 as const;

const store = new JsonStore<MediaEntry[]>({
  path: STORE_FILE,
  defaultValue: [],
  schemaVersion: SCHEMA_VERSION,
  validate: (raw) => {
    if (!Array.isArray(raw)) throw new Error("media-index: not an array");
    return raw.filter(isMediaEntry);
  },
  migrate: (raw, fromVersion) => {
    // Pre-envelope shape (`fromVersion === 0`): the file was a bare
    // `MediaEntry[]`. JsonStore detects "no envelope detected" as
    // version 0; lift to v1 unchanged.
    if (fromVersion !== 0) return null;
    if (!Array.isArray(raw))
      return { value: [], schemaVersion: SCHEMA_VERSION };
    return {
      value: raw.filter(isMediaEntry),
      schemaVersion: SCHEMA_VERSION,
    };
  },
});

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

export function loadMediaIndex(): void {
  // JsonStore.loadSync walks `<path>` → `<path>.bak` → defaultValue
  // using only sync fs primitives, so behaviour matches the legacy
  // synchronous load. Reset the loaded flag first so tests that
  // re-mock the filesystem between cases see a fresh read.
  store.reset();
  try {
    store.loadSync();
  } catch (err) {
    logError("workspace", "Media index load failed", err);
  }
  purgeExpired();
}

function save(): void {
  if (!store.isDirty()) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    store.saveSync();
  } catch (err) {
    logError("workspace", "Media index save failed", err);
  }
}

const autoSaveTimer = setInterval(save, 30_000);
registerCleanup(save);

export function flushMediaIndex(): void {
  clearInterval(autoSaveTimer);
  // Force a synchronous flush. Mark dirty so JsonStore commits the
  // envelope even if no addMedia was called this turn.
  store.update(() => undefined);
  save();
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export function addMedia(entry: Omit<MediaEntry, "id">): void {
  const id = `${entry.chatId}:${entry.msgId}`;
  store.update((entries) => {
    const existing = entries.findIndex((e) => e.id === id);
    if (existing >= 0) entries[existing] = { ...entry, id };
    else entries.push({ ...entry, id });
  });
}

/** Get recent media for a chat, newest first. */
export function getRecentMedia(chatId: string, limit = 10): MediaEntry[] {
  return store
    .get()
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
  return store
    .get()
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
  let removed = 0;
  store.update((entries) => {
    const survivors: MediaEntry[] = [];
    for (const e of entries) {
      if (e.timestamp >= cutoff) {
        survivors.push(e);
        continue;
      }
      try {
        if (existsSync(e.filePath)) unlinkSync(e.filePath);
      } catch {
        /* skip */
      }
      removed++;
    }
    if (removed > 0) {
      entries.length = 0;
      entries.push(...survivors);
    }
  });
  if (removed > 0) {
    log("workspace", `Purged ${removed} expired media entries`);
  }
}
