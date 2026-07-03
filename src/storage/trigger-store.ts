/**
 * Persistent trigger store, backed by the `triggers` table.
 *
 * Triggers are bot-authored scripts that run as supervised long-running
 * subprocesses and signal back to fire wake-up messages into a chat.
 * Supervision metadata lives in SQLite (transactional, so a crash
 * can't tear the store mid-status-flip); script bodies and run logs
 * stay next to each other on disk under `~/.talon/data/trigger-runs/`.
 * The one-shot legacy import accepts the JsonStore envelope, the
 * pre-envelope bare object, and the original bare-array triggers.json.
 */

import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { log, logError } from "../util/log.js";
import { dirs, files } from "../util/paths.js";
import { importLegacyJson } from "./legacy-import.js";
import { inTransaction } from "./db.js";
import * as repo from "./repositories/triggers-repo.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type TriggerLanguage = "bash" | "python" | "node" | "lua";

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
  /** Linux /proc/<pid>/stat field 22 (start time in jiffies) captured at
   *  spawn. Used by killOrphan to defend against PID reuse — start time is
   *  monotonic per boot and unchanged by exec(), so a match guarantees the
   *  current owner of the PID is the same process we spawned. Undefined on
   *  non-Linux platforms. */
  pidStarttime?: number;
  /** Hard timeout in seconds. Default 24h, max 7d. */
  timeoutSeconds: number;
  /** Exit code on terminal status. */
  exitCode?: number;
  /** Total wake-ups fired for this trigger — sum of mid-run TALON_FIRE: lines
   *  plus the terminal exit fire. Incremented every time fireWake() runs. */
  fireCount: number;
  lastFireAt?: number;
  /** Truncated tail of the most recent fire payload (for diagnostics). */
  lastFirePayload?: string;
  lastError?: string;
  /** If true, the trigger is respawned on Talon startup if it was still
   *  active when Talon went down. Triggers in any terminal state
   *  (fired/errored/cancelled) are NOT respawned — only ones interrupted
   *  by Talon shutdown or crash. (Persistent triggers have no hard timeout,
   *  so timed_out is unreachable for them — see spawnTrigger.) */
  persistent?: boolean;
  /**
   * Optional model override for the wake-up turn — a model id valid on the
   * chat's own backend. Unset = inherit the chat's model (preferred). When set,
   * the fired wake-up runs on this (typically cheaper) model instead, while
   * still resuming the chat session (restricted to the same backend so
   * continuity is preserved).
   */
  model?: string;
};

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_SECONDS = 24 * 60 * 60; // 24h
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60; // 7d
/** Per-chat soft cap on simultaneously active triggers. */
export const MAX_ACTIVE_PER_CHAT = 5;
/** Truncate fire payloads at this many bytes to keep wake prompts sane. */
export const FIRE_PAYLOAD_MAX_BYTES = 4_096;

function isTrigger(value: unknown): value is Trigger {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

// ── Startup ──────────────────────────────────────────────────────────────────

/**
 * One-shot legacy import + restart recovery. Any trigger that was
 * "running"/"pending" when the previous process died needs handling:
 * non-persistent ones are marked "terminated" so the bot gets a wake
 * fire about what happened — the child was either killed on clean
 * shutdown, or torn down with a Docker/systemd cgroup on crash.
 * (Outside a cgroup, a crash could leave the child orphaned and alive,
 * but we don't try to recover non-persistent triggers — that's what
 * persistent is for.) Persistent triggers are parked in "pending" with
 * their pid preserved so resumeAfterRestart can probe the stored pid,
 * SIGKILL any surviving orphan, and re-spawn.
 */
export function loadTriggers(): void {
  try {
    importLegacyJson({
      path: files.triggers,
      category: "triggers",
      what: "trigger(s)",
      ingest: (data) => {
        const triggers = Array.isArray(data)
          ? data
          : data && typeof data === "object"
            ? Object.values(data)
            : [];
        let imported = 0;
        inTransaction(() => {
          for (const t of triggers) {
            if (!isTrigger(t)) continue;
            repo.upsert(t);
            imported++;
          }
        });
        return imported;
      },
    });

    const { terminated, parked } = repo.recoverInterrupted(Date.now());

    const count = repo.count();
    if (count > 0) {
      const notes: string[] = [];
      if (terminated > 0) notes.push(`${terminated} terminated by restart`);
      if (parked > 0) notes.push(`${parked} persistent → will respawn`);
      log(
        "triggers",
        `Loaded ${count} trigger(s)${notes.length ? ` (${notes.join(", ")})` : ""}`,
      );
    }
  } catch (err) {
    logError("triggers", "Failed to load triggers", err);
  }
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
    case "lua":
      return "lua";
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
  "lua",
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
  repo.upsert(t);
}

export function getTrigger(id: string): Trigger | undefined {
  return repo.get(id);
}

export function getTriggerByName(
  chatId: string,
  name: string,
): Trigger | undefined {
  return repo.getByName(chatId, name);
}

export function getTriggersForChat(chatId: string): Trigger[] {
  return repo.listByChat(chatId);
}

export function getActiveTriggersForChat(chatId: string): Trigger[] {
  return getTriggersForChat(chatId).filter(
    (t) => t.status === "running" || t.status === "pending",
  );
}

export function getAllTriggers(): Trigger[] {
  return repo.listAll();
}

/**
 * Merge `updates` into the stored trigger. A key present with value
 * `undefined` clears that field (Object.assign semantics, matching the
 * in-memory era — the supervisor relies on it to drop e.g. a dead pid).
 */
export function updateTrigger(
  id: string,
  updates: Partial<Trigger>,
): Trigger | undefined {
  return inTransaction(() => {
    const existing = repo.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...updates };
    repo.upsert(merged);
    return merged;
  });
}

/** Delete a trigger and best-effort clean up its on-disk script + log. */
export function deleteTrigger(id: string): boolean {
  const t = repo.get(id);
  if (!t) return false;
  repo.remove(id);
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

/** Test-only: wipe the table between suites sharing a worker DB. */
export function _resetTriggersForTesting(): void {
  repo.removeAll();
}
