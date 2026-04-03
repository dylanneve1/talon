/**
 * Reflection journal — a chronological log of the bot's own thoughts,
 * decisions, and reflections that persists across sessions.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { log, logError } from "../util/log.js";
import { dirs } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type JournalEntryType =
  | "reflection"
  | "decision"
  | "observation"
  | "plan"
  | "error_analysis";

export type JournalEntry = {
  id: string;
  timestamp: string;
  type: JournalEntryType;
  content: string;
  relatedChats?: string[];
  relatedUsers?: number[];
  tags?: string[];
};

type JournalStore = {
  version: 1;
  entries: JournalEntry[];
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 200;
const STORE_FILE = resolve(dirs.memory, "journal.json");

// ── State ────────────────────────────────────────────────────────────────────

let store: JournalStore = {
  version: 1,
  entries: [],
};

let dirty = false;

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadJournal(): void {
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    if (existsSync(STORE_FILE)) {
      const raw = readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as JournalStore;
      if (parsed.version === 1) {
        store = parsed;
        log("journal", `Loaded ${store.entries.length} journal entries`);
      }
    }
  } catch (err) {
    logError("journal", "Failed to load journal", err);
  }
}

export function flushJournal(): void {
  if (!dirty) return;
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    const data = JSON.stringify(store, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try {
        writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE));
      } catch {
        /* best effort */
      }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("journal", "Failed to flush journal", err);
  }
}

registerCleanup(() => flushJournal());

// ── Core functions ───────────────────────────────────────────────────────────

export function addJournalEntry(
  type: JournalEntryType,
  content: string,
  tags?: string[],
  relatedChats?: string[],
  relatedUsers?: number[],
): string {
  const entry: JournalEntry = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    content,
    ...(relatedChats?.length ? { relatedChats } : {}),
    ...(relatedUsers?.length ? { relatedUsers } : {}),
    ...(tags?.length ? { tags } : {}),
  };

  store.entries.push(entry);

  // FIFO: trim to max entries
  if (store.entries.length > MAX_ENTRIES) {
    store.entries = store.entries.slice(store.entries.length - MAX_ENTRIES);
  }

  dirty = true;
  flushJournal();
  log("journal", `Added ${type} entry: ${content.slice(0, 60)}... (${entry.id})`);
  return entry.id;
}

export function getRecentEntries(
  limit?: number,
  type?: JournalEntryType,
): JournalEntry[] {
  let entries = store.entries;
  if (type) {
    entries = entries.filter((e) => e.type === type);
  }
  const n = Math.min(limit ?? 10, entries.length);
  return entries.slice(-n);
}

export function searchJournal(query: string): JournalEntry[] {
  const lower = query.toLowerCase();
  return store.entries.filter(
    (e) =>
      e.content.toLowerCase().includes(lower) ||
      e.type.toLowerCase().includes(lower) ||
      e.tags?.some((t) => t.toLowerCase().includes(lower)),
  );
}
