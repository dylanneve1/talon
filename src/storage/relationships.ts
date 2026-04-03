/**
 * Relationship graph — tracks connections between users, chats, and topics.
 *
 * Builds a lightweight social graph from co-presence signals (two users
 * active in the same chat) and chat activity. The graph is persisted to
 * disk and exposed via actions/MCP tools so Claude can reason about
 * cross-chat relationships.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { log, logError } from "../util/log.js";
import { dirs } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type Relationship = {
  userA: number;
  userB: number;
  strength: number;       // 0-1, how often they interact
  sharedChats: string[];  // chat IDs where both are present
  lastInteraction: string;
  context?: string;       // brief note about the relationship
};

export type ChatProfile = {
  chatId: string;
  title?: string;
  type: "dm" | "group" | "channel";
  activeUsers: number[];
  topTopics: string[];        // most discussed topics
  messageCount: number;
  lastActive: string;
  summary?: string;           // brief chat description
};

export type RelationshipGraph = {
  version: 1;
  relationships: Relationship[];
  chatProfiles: Record<string, ChatProfile>;
  topicClusters: Record<string, string[]>; // topic → related topics
};

// ── Constants ────────────────────────────────────────────────────────────────

const STORE_FILE = `${dirs.memory}/relationships.json`;
const MAX_RELATIONSHIPS = 2000;
const MAX_CHAT_PROFILES = 500;
const MAX_ACTIVE_USERS_PER_CHAT = 50;
const STRENGTH_INCREMENT = 0.02;
const STRENGTH_MAX = 1.0;

// ── State ────────────────────────────────────────────────────────────────────

let graph: RelationshipGraph = {
  version: 1,
  relationships: [],
  chatProfiles: {},
  topicClusters: {},
};

let dirty = false;

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadRelationships(): void {
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(STORE_FILE)) {
      const raw = readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as RelationshipGraph;
      if (parsed.version === 1) {
        graph = parsed;
        log("relationships", `Loaded: ${graph.relationships.length} relationships, ${Object.keys(graph.chatProfiles).length} chat profiles`);
      }
    }
  } catch (err) {
    // Try backup
    const bakFile = STORE_FILE + ".bak";
    try {
      if (existsSync(bakFile)) {
        const raw = readFileSync(bakFile, "utf-8");
        const parsed = JSON.parse(raw) as RelationshipGraph;
        if (parsed.version === 1) {
          graph = parsed;
          logError("relationships", "Loaded from backup (primary was corrupt)");
          return;
        }
      }
    } catch { /* backup also corrupt */ }
    logError("relationships", "Failed to load relationship graph", err);
  }
}

export function flushRelationships(): void {
  if (!dirty) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = JSON.stringify(graph, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try { writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE)); } catch { /* best effort */ }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("relationships", "Failed to flush relationship graph", err);
  }
}

// Auto-save every 60 seconds
const autoSaveTimer = setInterval(flushRelationships, 60_000);
registerCleanup(() => {
  clearInterval(autoSaveTimer);
  flushRelationships();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Canonical key for a pair of users (always smaller ID first). */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function findRelationship(userA: number, userB: number): Relationship | undefined {
  return graph.relationships.find(
    (r) => pairKey(r.userA, r.userB) === pairKey(userA, userB),
  );
}

// ── Core functions ───────────────────────────────────────────────────────────

/**
 * Record that two users were seen in the same chat — strengthens their
 * relationship and tracks shared chats.
 */
export function recordCoPresence(userA: number, userB: number, chatId: string): void {
  if (userA === userB || !userA || !userB) return;

  // Canonical ordering
  const [lo, hi] = userA < userB ? [userA, userB] : [userB, userA];

  let rel = findRelationship(lo, hi);
  if (!rel) {
    // Enforce relationship limit — evict weakest
    if (graph.relationships.length >= MAX_RELATIONSHIPS) {
      graph.relationships.sort((a, b) => a.strength - b.strength);
      graph.relationships.splice(0, Math.floor(MAX_RELATIONSHIPS * 0.1));
    }

    rel = {
      userA: lo,
      userB: hi,
      strength: 0,
      sharedChats: [],
      lastInteraction: new Date().toISOString(),
    };
    graph.relationships.push(rel);
  }

  rel.strength = Math.min(STRENGTH_MAX, rel.strength + STRENGTH_INCREMENT);
  rel.lastInteraction = new Date().toISOString();
  if (!rel.sharedChats.includes(chatId)) {
    rel.sharedChats.push(chatId);
  }

  dirty = true;
}

/**
 * Track activity in a chat — updates the chat profile.
 */
export function recordChatActivity(
  chatId: string,
  title: string,
  type: "dm" | "group" | "channel",
  userId: number,
): void {
  let profile = graph.chatProfiles[chatId];
  if (!profile) {
    // Enforce chat profile limit
    const keys = Object.keys(graph.chatProfiles);
    if (keys.length >= MAX_CHAT_PROFILES) {
      // Evict least recently active
      let oldestKey = keys[0];
      let oldestTime = graph.chatProfiles[oldestKey].lastActive;
      for (const k of keys) {
        if (graph.chatProfiles[k].lastActive < oldestTime) {
          oldestKey = k;
          oldestTime = graph.chatProfiles[k].lastActive;
        }
      }
      delete graph.chatProfiles[oldestKey];
    }

    profile = {
      chatId,
      title: title || undefined,
      type,
      activeUsers: [],
      topTopics: [],
      messageCount: 0,
      lastActive: new Date().toISOString(),
    };
    graph.chatProfiles[chatId] = profile;
  }

  if (title) profile.title = title;
  profile.type = type;
  profile.messageCount++;
  profile.lastActive = new Date().toISOString();

  if (userId && !profile.activeUsers.includes(userId)) {
    profile.activeUsers.push(userId);
    if (profile.activeUsers.length > MAX_ACTIVE_USERS_PER_CHAT) {
      profile.activeUsers = profile.activeUsers.slice(-MAX_ACTIVE_USERS_PER_CHAT);
    }
  }

  dirty = true;
}

// ── Query functions ──────────────────────────────────────────────────────────

export function getRelationship(userA: number, userB: number): Relationship | null {
  return findRelationship(userA, userB) ?? null;
}

export function getUserNetwork(userId: number, limit = 10): Relationship[] {
  return graph.relationships
    .filter((r) => r.userA === userId || r.userB === userId)
    .sort((a, b) => b.strength - a.strength)
    .slice(0, limit);
}

export function getChatProfile(chatId: string): ChatProfile | null {
  return graph.chatProfiles[chatId] ?? null;
}

export function getMostActiveChats(limit = 10): ChatProfile[] {
  return Object.values(graph.chatProfiles)
    .sort((a, b) => b.lastActive.localeCompare(a.lastActive))
    .slice(0, limit);
}

export function findCommonGround(
  userA: number,
  userB: number,
): { relationship: Relationship | null; sharedChats: ChatProfile[]; sharedTopics: string[] } {
  const rel = findRelationship(userA, userB) ?? null;

  // Find chats where both users appear
  const sharedChats: ChatProfile[] = [];
  for (const profile of Object.values(graph.chatProfiles)) {
    if (profile.activeUsers.includes(userA) && profile.activeUsers.includes(userB)) {
      sharedChats.push(profile);
    }
  }

  // Find shared topics across the chats they share
  const topicCounts = new Map<string, number>();
  for (const chat of sharedChats) {
    for (const topic of chat.topTopics) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
  }
  const sharedTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  return { relationship: rel, sharedChats, sharedTopics };
}

/**
 * Set a summary for a chat profile (typically called by heartbeat).
 */
export function setChatSummary(chatId: string, summary: string): boolean {
  const profile = graph.chatProfiles[chatId];
  if (!profile) return false;
  profile.summary = summary;
  dirty = true;
  return true;
}
