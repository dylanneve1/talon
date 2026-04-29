/**
 * Persistent trigger store.
 *
 * Triggers are bot-authored scripts that run as supervised long-running
 * subprocesses and signal back to fire wake-up messages into a chat.
 *
 * Same on-disk pattern as cron-store: in-memory Map with dirty-flag auto-save.
 * Script bodies live next to the metadata under ~/.talon/data/trigger-runs/.
 */

import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import { dirname, resolve } from "node:path";
import { log, logError } from "../util/log.js";
import { recordError } from "../util/watchdog.js";
import { dirs, files } from "../util/paths.js";
import { registerCleanup } from "../util/cleanup-registry.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type TriggerLanguage = "bash" | "python" | "node";

export type TriggerStatus =
  | "pending" // created, not yet spawned (transient)
  | "running" // child process alive
  | "fired" // exited 0 — fired final wake message
  | "errored" // exited non-zero — fired error wake message
  | "cancelled" // killed by user (trigger_cancel)
  | "timed_out" // killed by hard timeout
  | "terminated"; // killed by Talon shutdown / restart

export type Trigger = {
  id: string;
  chatId: string;
  numericChatId: number;
  name: string;
  language: TriggerLanguage;
  /** Absolute path to the script body on disk. */
  scriptPath: string;
  /** Absolute path to the run log (interleaved stdout+stderr). */
  logPath: string;
  description?: string;
  status: TriggerStatus;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** PID of the child process while running (cleared on exit). */
  pid?: number;
  /** Hard timeout in seconds. Default 24h, max 7d. */
  timeoutSeconds: number;
  /** Exit code on terminal status. */
  exitCode?: number;
  /** Number of mid-run TALON_FIRE: lines emitted. */
  fireCount: number;
  lastFireAt?: number;
  /** Truncated tail of the most recent fire payload (for diagnostics). */
  lastFirePayload?: string;
  lastError?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60; // 24h
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60; // 7d
/** Per-chat soft cap on simultaneously active triggers. */
export const MAX_ACTIVE_PER_CHAT = 5;
/** Truncate fire payloads at this many bytes to keep wake prompts sane. */
export const FIRE_PAYLOAD_MAX_BYTES = 4_096;

const STORE_FILE = files.triggers;
let store: Record<string, Trigger> = {};
let dirty = false;

// ── Persistence ──────────────────────────────────────────────────────────────

export function loadTriggers(): void {
  try {
    if (existsSync(STORE_FILE)) {
      const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
      store = typeof raw === "object" && raw !== null ? raw : {};
    }
  } catch {
    const bakFile = STORE_FILE + ".bak";
    try {
      if (existsSync(bakFile)) {
        const raw = JSON.parse(readFileSync(bakFile, "utf-8"));
        store = typeof raw === "object" && raw !== null ? raw : {};
        log("triggers", "Loaded from backup (primary was corrupt)");
      }
    } catch {
      /* both corrupt — start empty */
    }
  }

  // On startup any "running" trigger from a previous process is dead — its
  // child PID was orphaned (we kill children on shutdown, but a crash bypasses
  // that path). Mark as terminated so the bot can see what happened.
  let resurrected = 0;
  for (const t of Object.values(store)) {
    if (t.status === "running" || t.status === "pending") {
      t.status = "terminated";
      t.endedAt = t.endedAt ?? Date.now();
      t.lastError = t.lastError ?? "Talon restarted while trigger was running";
      t.pid = undefined;
      dirty = true;
      resurrected++;
    }
  }

  const count = Object.keys(store).length;
  if (count > 0) {
    log(
      "triggers",
      `Loaded ${count} trigger(s)${resurrected > 0 ? ` (${resurrected} terminated by previous restart)` : ""}`,
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
      try {
        writeFileAtomic.sync(STORE_FILE + ".bak", readFileSync(STORE_FILE));
      } catch {
        /* best effort */
      }
    }
    writeFileAtomic.sync(STORE_FILE, data);
    dirty = false;
  } catch (err) {
    logError("triggers", "Failed to persist triggers", err);
    recordError(
      `Trigger save failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

const autoSaveTimer = setInterval(save, 10_000);
registerCleanup(save);

export function flushTriggers(): void {
  clearInterval(autoSaveTimer);
  save();
}

/** Mark store as dirty and save synchronously. */
export function persistNow(): void {
  dirty = true;
  save();
}

// ── ID + path helpers ────────────────────────────────────────────────────────

export function generateTriggerId(): string {
  return `trig_${randomUUID()}`;
}

export function languageExtension(lang: TriggerLanguage): string {
  switch (lang) {
    case "bash":
      return "sh";
    case "python":
      return "py";
    case "node":
      return "js";
  }
}

export function triggerScriptPath(
  chatId: string,
  id: string,
  lang: TriggerLanguage,
): string {
  return resolve(
    dirs.triggerRuns,
    sanitizeChatId(chatId),
    `${id}.${languageExtension(lang)}`,
  );
}

export function triggerLogPath(chatId: string, id: string): string {
  return resolve(dirs.triggerRuns, sanitizeChatId(chatId), `${id}.log`);
}

/** Restrict chatId to filesystem-safe characters for path use. */
export function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ── Validation ───────────────────────────────────────────────────────────────

const NAME_RE = /^[a-zA-Z0-9 _.-]{1,64}$/;
const SUPPORTED_LANGUAGES: readonly TriggerLanguage[] = [
  "bash",
  "python",
  "node",
];
const SCRIPT_MAX_BYTES = 64 * 1024;

export function validateLanguage(value: unknown): value is TriggerLanguage {
  return (
    typeof value === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
  );
}

export function validateName(name: string): string | null {
  if (!name) return "Missing name";
  if (!NAME_RE.test(name))
    return "Name must be 1-64 chars of letters, digits, spaces, dot, dash, underscore";
  return null;
}

export function validateScript(script: string): string | null {
  if (!script || !script.trim()) return "Missing script body";
  if (Buffer.byteLength(script, "utf-8") > SCRIPT_MAX_BYTES)
    return `Script too large (max ${SCRIPT_MAX_BYTES} bytes)`;
  return null;
}

export function validateTimeout(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0)
    return "Timeout must be a positive number";
  if (seconds > MAX_TIMEOUT_SECONDS)
    return `Timeout exceeds max (${MAX_TIMEOUT_SECONDS}s = 7d)`;
  return null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function addTrigger(t: Trigger): void {
  store[t.id] = t;
  dirty = true;
  save();
}

export function getTrigger(id: string): Trigger | undefined {
  return store[id];
}

export function getTriggerByName(
  chatId: string,
  name: string,
): Trigger | undefined {
  return Object.values(store).find(
    (t) => t.chatId === chatId && t.name === name,
  );
}

export function getTriggersForChat(chatId: string): Trigger[] {
  return Object.values(store).filter((t) => t.chatId === chatId);
}

export function getActiveTriggersForChat(chatId: string): Trigger[] {
  return getTriggersForChat(chatId).filter(
    (t) => t.status === "running" || t.status === "pending",
  );
}

export function getAllTriggers(): Trigger[] {
  return Object.values(store);
}

export function updateTrigger(
  id: string,
  updates: Partial<Trigger>,
): Trigger | undefined {
  const t = store[id];
  if (!t) return undefined;
  Object.assign(t, updates);
  dirty = true;
  return t;
}

/** Delete a trigger and best-effort clean up its on-disk script + log. */
export function deleteTrigger(id: string): boolean {
  const t = store[id];
  if (!t) return false;
  delete store[id];
  dirty = true;
  save();
  for (const path of [t.scriptPath, t.logPath]) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }
  return true;
}

/** Write a script body for a trigger, creating directories as needed. */
export function writeScriptFile(
  chatId: string,
  id: string,
  lang: TriggerLanguage,
  body: string,
): string {
  const path = triggerScriptPath(chatId, id, lang);
  mkdirSync(dirname(path), { recursive: true });
  // 0o700: only the user running Talon should be able to read/exec scripts
  writeFileSync(path, body, { encoding: "utf-8", mode: 0o700 });
  return path;
}

/** Read a trigger's run log, returning the last `lines` lines. */
export function readTriggerLogTail(
  logPath: string,
  lines: number,
): { tail: string; truncated: boolean } {
  try {
    if (!existsSync(logPath)) return { tail: "", truncated: false };
    const raw = readFileSync(logPath, "utf-8");
    const all = raw.split(/\r?\n/);
    if (all.length <= lines) return { tail: all.join("\n"), truncated: false };
    return { tail: all.slice(-lines).join("\n"), truncated: true };
  } catch (err) {
    return {
      tail: `Failed to read log: ${err instanceof Error ? err.message : err}`,
      truncated: false,
    };
  }
}

/** Reset the in-memory store. Test helper only. */
export function _resetTriggersForTesting(): void {
  store = {};
  dirty = false;
}
