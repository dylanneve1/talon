/**
 * Workspace — Claude's home directory.
 * Talon only ensures the root exists. Claude organizes it however it wants.
 * Includes periodic cleanup of old uploads to prevent disk exhaustion.
 */

import { existsSync, mkdirSync, readdirSync, rmdirSync, renameSync, statSync, unlinkSync, copyFileSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { log } from "./log.js";
import { dirs, files as pathFiles } from "./paths.js";

const IDENTITY_SEED = `# Identity

<!-- This file defines who you are. It's empty because you're new here. -->
<!-- On your first conversation, ask the user to help you fill this in: -->
<!--   - What should I be called? -->
<!--   - Who are you? Who created me? -->
<!--   - What will I be used for? -->
<!-- Then write your identity here using the Write tool. Keep it concise. -->
`;

// ── Layout migration ────────────────────────────────────────────────────────

/**
 * Migrate from the old workspace/ layout to the new .talon/ layout.
 * Only runs if workspace/ exists and .talon/ does not.
 * Uses renameSync (same filesystem, atomic).
 */
export function migrateLayout(): void {
  const oldRoot = resolve(process.cwd(), "workspace");
  if (!existsSync(oldRoot) || existsSync(dirs.root)) return;

  log("workspace", "Migrating workspace/ → .talon/ layout");

  // Create target directories
  mkdirSync(dirs.data, { recursive: true });
  mkdirSync(dirs.workspace, { recursive: true });

  // File moves: old → new
  const fileMoves: Array<[string, string]> = [
    [join(oldRoot, "talon.json"), dirs.root + "/config.json"],
    [join(oldRoot, "sessions.json"), join(dirs.data, "sessions.json")],
    [join(oldRoot, "history.json"), join(dirs.data, "history.json")],
    [join(oldRoot, "chat-settings.json"), join(dirs.data, "chat-settings.json")],
    [join(oldRoot, "cron.json"), join(dirs.data, "cron.json")],
    [join(oldRoot, "media-index.json"), join(dirs.data, "media-index.json")],
    [join(oldRoot, "talon.log"), join(dirs.root, "talon.log")],
    [join(oldRoot, ".user-session"), join(dirs.root, ".user-session")],
  ];

  // Move helper — try rename first (fast, same filesystem), fall back to copy+delete
  const moveFile = (src: string, dst: string) => {
    try {
      renameSync(src, dst);
    } catch {
      // Cross-filesystem: copy then delete
      copyFileSync(src, dst);
      unlinkSync(src);
    }
    log("workspace", `Moved ${src} → ${dst}`);
  };

  for (const [src, dst] of fileMoves) {
    if (existsSync(src)) moveFile(src, dst);
  }

  // Directory moves: old → new
  const dirMoves: Array<[string, string]> = [
    [join(oldRoot, "memory"), join(dirs.workspace, "memory")],
    [join(oldRoot, "uploads"), join(dirs.workspace, "uploads")],
    [join(oldRoot, "logs"), join(dirs.workspace, "logs")],
    [join(oldRoot, "stickers"), join(dirs.workspace, "stickers")],
  ];

  for (const [src, dst] of dirMoves) {
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
      } catch {
        // Cross-filesystem: use cpSync (Node 16+) then rmSync
        cpSync(src, dst, { recursive: true });
        rmSync(src, { recursive: true, force: true });
      }
      log("workspace", `Moved ${src} → ${dst}`);
    }
  }

  // Remove old workspace/ if empty
  try {
    const remaining = readdirSync(oldRoot);
    if (remaining.length === 0) {
      rmdirSync(oldRoot);
      log("workspace", "Removed empty workspace/ directory");
    } else {
      log("workspace", `Old workspace/ still has ${remaining.length} item(s) — not removed`);
    }
  } catch { /* ignore */ }

  log("workspace", "Migration complete");
}

// ── Workspace init ───────────────────────────────────────────────────────────

/** Ensure workspace directories exist. */
export function initWorkspace(root: string): void {
  migrateLayout();
  // Ensure .talon/ tree exists
  for (const dir of [dirs.root, dirs.data, dirs.workspace]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  // Ensure the caller-supplied root exists too (may differ in tests)
  if (!existsSync(root)) mkdirSync(root, { recursive: true });

  // Seed identity.md for new workspaces
  if (!existsSync(pathFiles.identity)) {
    writeFileSync(pathFiles.identity, IDENTITY_SEED);
  }
}

/** Calculate total disk usage of the workspace in bytes. */
export function getWorkspaceDiskUsage(root: string): number {
  let total = 0;
  function walk(dir: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          try { total += statSync(full).size; } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
  walk(root);
  return total;
}

// ── Upload cleanup ──────────────────────────────────────────────────────────

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // check every hour
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Delete files in uploads/ older than maxAgeMs.
 * Returns number of files deleted.
 */
export function cleanupUploads(root: string, maxAgeMs = DEFAULT_MAX_AGE_MS): number {
  const uploadsDir = join(root, "uploads");
  if (!existsSync(uploadsDir)) return 0;

  const now = Date.now();
  let deleted = 0;

  try {
    for (const entry of readdirSync(uploadsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = join(uploadsDir, entry.name);
      try {
        const stat = statSync(filePath);
        if (now - stat.mtimeMs >= maxAgeMs) {
          unlinkSync(filePath);
          deleted++;
        }
      } catch { /* skip individual file errors */ }
    }
  } catch { /* skip if directory unreadable */ }

  if (deleted > 0) {
    log("workspace", `Cleaned up ${deleted} old upload(s)`);
  }
  return deleted;
}

/** Start periodic upload cleanup. Call once at startup. */
export function startUploadCleanup(root: string): void {
  if (cleanupTimer) return;
  // Run once immediately, then every hour
  cleanupUploads(root);
  cleanupTimer = setInterval(() => cleanupUploads(root), CLEANUP_INTERVAL_MS);
}

/** Stop the cleanup timer. */
export function stopUploadCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
