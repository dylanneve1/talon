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
 *         daily/               Per-day memory notes (YYYY-MM-DD.md)
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
  /** Daily memory notes: ~/.talon/workspace/memory/daily/ */
  dailyMemory: resolve(TALON_ROOT, "workspace", "memory", "daily"),
  /** Sticker packs: ~/.talon/workspace/stickers/ */
  stickers: resolve(TALON_ROOT, "workspace", "stickers"),
  /** Prompt files: ~/.talon/prompts/ */
  prompts: resolve(TALON_ROOT, "prompts"),
  /** Per-chat message traces: ~/.talon/data/traces/ */
  traces: resolve(TALON_ROOT, "data", "traces"),
  /** MemPalace palace: ~/.talon/workspace/palace/ */
  palace: resolve(TALON_ROOT, "workspace", "palace"),
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
  /** Self-bootstrapping identity: ~/.talon/workspace/identity.md */
  identity: resolve(TALON_ROOT, "workspace", "identity.md"),
  /** Telegram userbot session: ~/.talon/.user-session */
  userSession: resolve(TALON_ROOT, ".user-session"),
  /** PID file for daemon mode: ~/.talon/talon.pid */
  pid: resolve(TALON_ROOT, "talon.pid"),
  /** MemPalace venv python binary: ~/.talon/mempalace-venv/bin/python */
  mempalacePython: resolve(
    TALON_ROOT,
    "mempalace-venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  ),
  /** Dream mode state: ~/.talon/workspace/memory/dream_state.json */
  dreamState: resolve(TALON_ROOT, "workspace", "memory", "dream_state.json"),
  /** Heartbeat state: ~/.talon/workspace/memory/heartbeat_state.json */
  heartbeatState: resolve(
    TALON_ROOT,
    "workspace",
    "memory",
    "heartbeat_state.json",
  ),
} as const;
