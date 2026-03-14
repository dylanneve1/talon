/**
 * Per-chat runtime settings. Overrides global config on a per-chat basis.
 * Persisted alongside sessions.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

export type ChatSettings = {
  /** Model override for this chat. */
  model?: string;
  /** Max thinking tokens override. */
  maxThinkingTokens?: number;
};

const STORE_FILE = resolve(process.cwd(), "workspace", "chat-settings.json");
let store: Record<string, ChatSettings> = {};
let dirty = false;

export function loadChatSettings(): void {
  try {
    if (existsSync(STORE_FILE)) {
      store = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
    }
  } catch {
    store = {};
  }
}

function save(): void {
  if (!dirty) return;
  try {
    const dir = dirname(STORE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(store, null, 2) + "\n");
    dirty = false;
  } catch {
    // Non-fatal
  }
}

setInterval(save, 10_000);
process.on("exit", save);

export function getChatSettings(chatId: string): ChatSettings {
  return store[chatId] ?? {};
}

export function setChatModel(chatId: string, model: string | undefined): void {
  if (!store[chatId]) store[chatId] = {};
  if (model) {
    store[chatId].model = model;
  } else {
    delete store[chatId].model;
  }
  dirty = true;
  save();
}

export function setChatThinking(chatId: string, tokens: number | undefined): void {
  if (!store[chatId]) store[chatId] = {};
  if (tokens) {
    store[chatId].maxThinkingTokens = tokens;
  } else {
    delete store[chatId].maxThinkingTokens;
  }
  dirty = true;
  save();
}

/** Named thinking presets. */
export const THINKING_PRESETS: Record<string, number> = {
  off: 0,
  low: 2000,
  medium: 8000,
  high: 16000,
  max: 32000,
};

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
  return MODEL_ALIASES[lower] ?? input.trim();
}
