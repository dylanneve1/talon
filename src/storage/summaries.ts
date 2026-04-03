/**
 * Conversation summarization system — auto-summarize chats at configurable thresholds.
 * Tracks rolling summaries, key topics, decisions, and pending items per chat.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { resolve } from "node:path";
import { log, logError } from "../util/log.js";
import { dirs } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ChatSummary = {
  chatId: string;
  title?: string;
  lastSummarized: string;     // ISO timestamp
  lastMessageCount: number;   // message count when last summarized
  summary: string;            // current rolling summary
  keyTopics: string[];        // main topics discussed
  keyDecisions: string[];     // decisions or conclusions reached
  pendingItems: string[];     // unanswered questions, TODOs mentioned
  participants: string[];     // active participant names
};

type SummaryStore = {
  version: 1;
  chats: Record<string, ChatSummary>;
};

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_FILE = resolve(dirs.memory, "summaries.json");
const SUMMARIZATION_THRESHOLD = 50; // messages since last summary

// ── State ────────────────────────────────────────────────────────────────────

let store: SummaryStore = {
  version: 1,
  chats: {},
};

let dirty = false;

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadSummaries(): void {
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    if (existsSync(STORE_FILE)) {
      const raw = readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as SummaryStore;
      if (parsed.version === 1) {
        store = parsed;
        log("summaries", `Loaded summaries for ${Object.keys(store.chats).length} chats`);
      }
    }
  } catch (err) {
    logError("summaries", "Failed to load summaries", err);
  }
}

export function flushSummaries(): void {
  if (!dirty) return;
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    const data = JSON.stringify(store, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try { writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE)); } catch { /* best effort */ }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("summaries", "Failed to flush summaries", err);
  }
}

registerCleanup(() => flushSummaries());

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Get the stored summary for a chat.
 */
export function getSummary(chatId: string): ChatSummary | null {
  return store.chats[chatId] ?? null;
}

/**
 * Update (or create) a chat summary.
 */
export function updateSummary(chatId: string, summary: Partial<ChatSummary> & { summary: string }): ChatSummary {
  const existing = store.chats[chatId];
  const now = new Date().toISOString();

  const updated: ChatSummary = {
    chatId,
    title: summary.title ?? existing?.title,
    lastSummarized: now,
    lastMessageCount: summary.lastMessageCount ?? existing?.lastMessageCount ?? 0,
    summary: summary.summary,
    keyTopics: summary.keyTopics ?? existing?.keyTopics ?? [],
    keyDecisions: summary.keyDecisions ?? existing?.keyDecisions ?? [],
    pendingItems: summary.pendingItems ?? existing?.pendingItems ?? [],
    participants: summary.participants ?? existing?.participants ?? [],
  };

  store.chats[chatId] = updated;
  dirty = true;
  return updated;
}

/**
 * Get all stored summaries.
 */
export function getAllSummaries(): Record<string, ChatSummary> {
  return store.chats;
}

/**
 * Check if a chat needs summarization based on message count threshold.
 */
export function needsSummarization(chatId: string, currentMsgCount: number): boolean {
  const existing = store.chats[chatId];
  if (!existing) return currentMsgCount >= SUMMARIZATION_THRESHOLD;
  return (currentMsgCount - existing.lastMessageCount) >= SUMMARIZATION_THRESHOLD;
}
