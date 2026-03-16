/**
 * Workspace — Claude's home directory.
 * Talon only ensures the root exists. Claude organizes it however it wants.
 * Includes periodic cleanup of old uploads to prevent disk exhaustion.
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/** Ensure workspace root exists. That's it — Claude manages the rest. */
export function initWorkspace(root: string): void {
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
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
