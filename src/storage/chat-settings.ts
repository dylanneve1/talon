/**
 * Per-chat runtime settings. Overrides global config on a per-chat basis.
 * Persisted alongside sessions.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import writeFileAtomic from "write-file-atomic";
import { dirname } from "node:path";
import { log } from "../util/log.js";
import { files } from "../util/paths.js";

export type EffortLevel = "off" | "low" | "medium" | "high" | "max";

export type ChatSettings = {
  /** Model override for this chat. */
  model?: string;
  /** Effort level override (maps to SDK thinking + effort options). */
  effort?: EffortLevel;
  /** Whether pulse is enabled for this chat. */
  pulse?: boolean;
  /** Per-chat pulse check interval in milliseconds. */
  pulseIntervalMs?: number;
};

const STORE_FILE = files.chatSettings;
let store: Record<string, ChatSettings> = {};
let dirty = false;

export function loadChatSettings(): void {
  try {
    if (existsSync(STORE_FILE)) {
      store = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
    }
  } catch {
    // Primary corrupt — try backup
    const bakFile = STORE_FILE + ".bak";
    try {
      if (existsSync(bakFile)) {
        store = JSON.parse(readFileSync(bakFile, "utf-8"));
        log("settings", "Loaded from backup (primary was corrupt)");
      }
    } catch { /* backup also corrupt */ }
  }
  // Migrate legacy maxThinkingTokens → effort
  let migrated = 0;
  for (const [chatId, settings] of Object.entries(store)) {
    const raw = settings as Record<string, unknown>;
    if ("maxThinkingTokens" in raw && !settings.effort) {
      const tokens = Number(raw.maxThinkingTokens);
      let effort: EffortLevel;
      if (tokens === 0) effort = "off";
      else if (tokens <= 2000) effort = "low";
      else if (tokens <= 8000) effort = "medium";
      else if (tokens <= 16000) effort = "high";
      else effort = "max";
      settings.effort = effort;
      delete raw.maxThinkingTokens;
      migrated++;
      log(
        "settings",
        `Migrated chat ${chatId}: maxThinkingTokens=${tokens} to effort=${effort}`,
      );
    } else if ("maxThinkingTokens" in raw) {
      // Has effort already, just clean up the old field
      delete raw.maxThinkingTokens;
      migrated++;
    }
  }
  if (migrated > 0) {
    dirty = true;
    save();
    log(
      "settings",
      `Migrated ${migrated} chat(s) from maxThinkingTokens to effort`,
    );
  }
}

function save(): void {
  if (!dirty) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data = JSON.stringify(store, null, 2) + "\n";
    if (existsSync(STORE_FILE)) {
      try { writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE)); } catch { /* best effort */ }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch {
    // Non-fatal
  }
}

const autoSaveTimer = setInterval(save, 10_000);
process.on("exit", save);

/** Flush settings to disk and stop the auto-save timer. */
export function flushChatSettings(): void {
  clearInterval(autoSaveTimer);
  save();
}

export function getChatSettings(chatId: string): ChatSettings {
  return store[chatId] ?? {};
}

function cleanupEmpty(chatId: string): void {
  const s = store[chatId];
  if (s && !s.model && !s.effort && s.pulse === undefined && s.pulseIntervalMs === undefined) {
    delete store[chatId];
  }
}

export function setChatModel(chatId: string, model: string | undefined): void {
  if (!store[chatId]) store[chatId] = {};
  if (model) {
    store[chatId].model = model;
  } else {
    delete store[chatId].model;
    cleanupEmpty(chatId);
  }
  dirty = true;
  save();
}

export function setChatEffort(
  chatId: string,
  effort: EffortLevel | undefined,
): void {
  if (!store[chatId]) store[chatId] = {};
  if (effort) {
    store[chatId].effort = effort;
  } else {
    delete store[chatId].effort;
    cleanupEmpty(chatId);
  }
  dirty = true;
  save();
}

export function setChatPulse(
  chatId: string,
  enabled: boolean | undefined,
): void {
  if (!store[chatId]) store[chatId] = {};
  if (enabled !== undefined) {
    store[chatId].pulse = enabled;
  } else {
    delete store[chatId].pulse;
    cleanupEmpty(chatId);
  }
  dirty = true;
  save();
}

export function setChatPulseInterval(
  chatId: string,
  intervalMs: number | undefined,
): void {
  if (!store[chatId]) store[chatId] = {};
  if (intervalMs !== undefined) {
    store[chatId].pulseIntervalMs = intervalMs;
  } else {
    delete store[chatId].pulseIntervalMs;
    cleanupEmpty(chatId);
  }
  dirty = true;
  save();
}

/** Get all chat IDs that have pulse enabled in settings. */
export function getRegisteredPulseChats(): string[] {
  return Object.entries(store)
    .filter(([, s]) => s.pulse === true)
    .map(([id]) => id);
}

/** Valid effort levels. */
export const EFFORT_LEVELS: EffortLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "max",
];

/** Known model aliases. */
export const MODEL_ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5",
  "sonnet-4.6": "claude-sonnet-4-6",
  "opus-4.6": "claude-opus-4-6",
  "haiku-4.5": "claude-haiku-4-5",
  "sonnet-4-6": "claude-sonnet-4-6",
  "opus-4-6": "claude-opus-4-6",
  "haiku-4-5": "claude-haiku-4-5",
};

export function resolveModelName(input: string): string {
  const lower = input.trim().toLowerCase();
  return Object.hasOwn(MODEL_ALIASES, lower) ? MODEL_ALIASES[lower] : input.trim();
}
