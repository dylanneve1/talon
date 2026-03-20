/**
 * Centralized path resolution for all Talon directories and files.
 *
 * Location: ~/.talon/ (cross-platform: Linux, macOS, Windows)
 *
 * Layout:
 *   ~/.talon/
 *     config.json              Main configuration
 *     data/                    Internal state (sessions, history, settings, cron, media)
 *       sessions.json
 *       history.json
 *       chat-settings.json
 *       cron.json
 *       media-index.json
 *     workspace/               User-facing workspace (memory, uploads, logs)
 *       memory/
 *       uploads/
 *       stickers/
 *       logs/
 *     talon.log                Structured log file
 *     .user-session            Telegram userbot session
 */

import { resolve } from "node:path";
import { homedir } from "node:os";

/** Root of the Talon data directory: ~/.talon/ */
const TALON_ROOT = resolve(homedir(), ".talon");

// ── Directories ────────────────────────────────────────────────────────────

export const dirs = {
  /** Root: ~/.talon/ */
  root: TALON_ROOT,
  /** Internal data: ~/.talon/data/ */
  data: resolve(TALON_ROOT, "data"),
  /** User workspace: ~/.talon/workspace/ */
  workspace: resolve(TALON_ROOT, "workspace"),
  /** Upload files: ~/.talon/workspace/uploads/ */
  uploads: resolve(TALON_ROOT, "workspace", "uploads"),
  /** Daily logs: ~/.talon/workspace/logs/ */
  logs: resolve(TALON_ROOT, "workspace", "logs"),
  /** Memory: ~/.talon/workspace/memory/ */
  memory: resolve(TALON_ROOT, "workspace", "memory"),
  /** Sticker packs: ~/.talon/workspace/stickers/ */
  stickers: resolve(TALON_ROOT, "workspace", "stickers"),
} as const;

// ── Files ──────────────────────────────────────────────────────────────────

export const files = {
  /** Main config: ~/.talon/config.json */
  config: resolve(TALON_ROOT, "config.json"),
  /** Structured log: ~/.talon/talon.log */
  log: resolve(TALON_ROOT, "talon.log"),
  /** Session store: ~/.talon/data/sessions.json */
  sessions: resolve(TALON_ROOT, "data", "sessions.json"),
  /** Chat history: ~/.talon/data/history.json */
  history: resolve(TALON_ROOT, "data", "history.json"),
  /** Per-chat settings: ~/.talon/data/chat-settings.json */
  chatSettings: resolve(TALON_ROOT, "data", "chat-settings.json"),
  /** Cron jobs: ~/.talon/data/cron.json */
  cron: resolve(TALON_ROOT, "data", "cron.json"),
  /** Media index: ~/.talon/data/media-index.json */
  mediaIndex: resolve(TALON_ROOT, "data", "media-index.json"),
  /** Persistent memory: ~/.talon/workspace/memory/memory.md */
  memory: resolve(TALON_ROOT, "workspace", "memory", "memory.md"),
  /** Telegram userbot session: ~/.talon/.user-session */
  userSession: resolve(TALON_ROOT, ".user-session"),
} as const;
