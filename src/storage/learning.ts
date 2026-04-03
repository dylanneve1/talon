/**
 * Learning system — tracks interaction patterns and generates insights.
 * Fed by the daily log and conversation data, produces actionable knowledge.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { resolve } from "node:path";
import { log, logError } from "../util/log.js";
import { dirs } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type UserProfile = {
  userId: number;
  name: string;
  username?: string;
  firstSeen: string;
  lastSeen: string;
  messageCount: number;
  topics: string[];           // frequently discussed topics
  preferences: string[];      // known preferences
  timezone?: string;          // inferred from activity patterns
  activityHours: number[];    // hour-of-day activity histogram (24 slots)
  sentiment: "positive" | "neutral" | "negative"; // overall interaction sentiment
};

export type Insight = {
  id: string;
  type: "user_pattern" | "topic_trend" | "system_health" | "improvement";
  content: string;
  createdAt: string;
  relevance: number;          // 0-1 score, decays over time
};

type LearningState = {
  version: 1;
  users: Record<string, UserProfile>;
  insights: Insight[];
  lastAnalysis: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_FILE = resolve(dirs.memory, "learning_state.json");
const MAX_INSIGHTS = 100;
const MAX_USERS = 500;
const MAX_TOPICS = 5;

// Common English stop words to exclude from topic extraction
const STOP_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
  "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
  "this", "but", "his", "by", "from", "they", "we", "say", "her",
  "she", "or", "an", "will", "my", "one", "all", "would", "there",
  "their", "what", "so", "up", "out", "if", "about", "who", "get",
  "which", "go", "me", "when", "make", "can", "like", "time", "no",
  "just", "him", "know", "take", "people", "into", "year", "your",
  "good", "some", "could", "them", "see", "other", "than", "then",
  "now", "look", "only", "come", "its", "over", "think", "also",
  "back", "after", "use", "two", "how", "our", "work", "first",
  "well", "way", "even", "new", "want", "because", "any", "these",
  "give", "day", "most", "us", "is", "are", "was", "were", "been",
  "has", "had", "did", "doing", "does", "am", "being", "got", "yeah",
  "yes", "ok", "okay", "lol", "haha", "oh", "um", "uh", "hey", "hi",
  "hello", "thanks", "thank", "please", "sorry", "right", "sure",
  "really", "very", "much", "too", "here", "where", "why", "did",
  "don", "didn", "doesn", "won", "shouldn", "wouldn", "couldn",
  "isn", "aren", "wasn", "weren", "let", "still", "thing", "things",
]);

// ── State ────────────────────────────────────────────────────────────────────

let state: LearningState = {
  version: 1,
  users: {},
  insights: [],
  lastAnalysis: new Date().toISOString(),
};

let dirty = false;

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadLearningState(): void {
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    if (existsSync(STORE_FILE)) {
      const raw = readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as LearningState;
      if (parsed.version === 1) {
        state = parsed;
        log("learning", `Loaded learning state: ${Object.keys(state.users).length} users, ${state.insights.length} insights`);
      }
    }
  } catch (err) {
    logError("learning", "Failed to load learning state", err);
  }
}

export function flushLearningState(): void {
  if (!dirty) return;
  try {
    if (!existsSync(dirs.memory)) {
      mkdirSync(dirs.memory, { recursive: true });
    }
    const data = JSON.stringify(state, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try { writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE)); } catch { /* best effort */ }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("learning", "Failed to flush learning state", err);
  }
}

registerCleanup(() => flushLearningState());

// ── Topic extraction ─────────────────────────────────────────────────────────

function extractWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
}

function updateTopics(profile: UserProfile, text: string): void {
  const words = extractWords(text);
  if (words.length === 0) return;

  // Build frequency map from existing topics (weighted) + new words
  const freq = new Map<string, number>();
  for (const t of profile.topics) {
    freq.set(t, (freq.get(t) ?? 0) + 5); // existing topics get a boost
  }
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  // Take top N
  profile.topics = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOPICS)
    .map(([word]) => word);
}

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Record an interaction from a user. Called on every incoming message.
 */
export function recordInteraction(
  userId: number,
  name: string,
  username: string | undefined,
  messageText: string,
): void {
  if (!userId) return;

  const key = String(userId);
  const now = new Date();
  const hour = now.getHours();

  let profile = state.users[key];
  if (!profile) {
    // Enforce user limit — evict least recently seen user
    const userKeys = Object.keys(state.users);
    if (userKeys.length >= MAX_USERS) {
      let oldestKey = userKeys[0];
      let oldestTime = state.users[oldestKey].lastSeen;
      for (const k of userKeys) {
        if (state.users[k].lastSeen < oldestTime) {
          oldestKey = k;
          oldestTime = state.users[k].lastSeen;
        }
      }
      delete state.users[oldestKey];
    }

    profile = {
      userId,
      name,
      username,
      firstSeen: now.toISOString(),
      lastSeen: now.toISOString(),
      messageCount: 0,
      topics: [],
      preferences: [],
      activityHours: new Array(24).fill(0) as number[],
      sentiment: "neutral",
    };
    state.users[key] = profile;
  }

  // Update profile
  profile.name = name;
  if (username) profile.username = username;
  profile.lastSeen = now.toISOString();
  profile.messageCount++;
  profile.activityHours[hour]++;

  // Update topics from message text
  if (messageText) {
    updateTopics(profile, messageText);
  }

  dirty = true;
}

/**
 * Retrieve the learned profile for a user.
 */
export function getUserProfile(userId: number): UserProfile | null {
  return state.users[String(userId)] ?? null;
}

/**
 * Get users who have been active in the last N hours.
 */
export function getActiveUsers(hours: number = 24): UserProfile[] {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return Object.values(state.users)
    .filter((u) => u.lastSeen >= cutoff)
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/**
 * Add a new insight.
 */
export function addInsight(
  type: Insight["type"],
  content: string,
): Insight {
  const insight: Insight = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    content,
    createdAt: new Date().toISOString(),
    relevance: 1.0,
  };

  state.insights.push(insight);

  // Enforce max insights — drop oldest low-relevance ones
  if (state.insights.length > MAX_INSIGHTS) {
    state.insights.sort((a, b) => b.relevance - a.relevance);
    state.insights = state.insights.slice(0, MAX_INSIGHTS);
  }

  dirty = true;
  return insight;
}

/**
 * Get recent insights, optionally filtered by type.
 */
export function getRecentInsights(
  limit: number = 10,
  type?: Insight["type"],
): Insight[] {
  let filtered = state.insights;
  if (type) {
    filtered = filtered.filter((i) => i.type === type);
  }
  return filtered
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

/**
 * Decay insight relevance and remove stale ones (relevance < 0.2).
 * Called by heartbeat on each run.
 */
export function pruneInsights(): number {
  const before = state.insights.length;
  for (const insight of state.insights) {
    insight.relevance = Math.max(0, insight.relevance - 0.1);
  }
  state.insights = state.insights.filter((i) => i.relevance >= 0.2);
  const pruned = before - state.insights.length;
  if (pruned > 0) dirty = true;
  return pruned;
}
