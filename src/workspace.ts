/**
 * Workspace directory structure management.
 * Ensures a clean, organized workspace on startup.
 */

import { existsSync, mkdirSync, renameSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { log } from "./log.js";

export type WorkspaceDirs = {
  root: string;
  memory: string;
  logs: string;
  uploads: string;
  files: string;
  sessions: string;
  scripts: string;
  data: string;
};

/**
 * Workspace structure:
 *
 * workspace/
 * ├── memory/          — persistent memory (memory.md, notes)
 * ├── logs/            — daily interaction logs (YYYY-MM-DD.md)
 * ├── uploads/         — files received from Telegram (photos, docs, voice)
 * ├── files/           — files created by Claude for sending back
 * ├── sessions/        — session metadata (sessions.json, chat-settings.json)
 * ├── scripts/         — scripts created by Claude
 * ├── data/            — data files created by Claude (CSV, JSON, etc.)
 * └── .user-session    — GramJS auth session (hidden)
 */
export function initWorkspace(root: string): WorkspaceDirs {
  const dirs: WorkspaceDirs = {
    root,
    memory: resolve(root, "memory"),
    logs: resolve(root, "logs"),
    uploads: resolve(root, "uploads"),
    files: resolve(root, "files"),
    sessions: resolve(root, "sessions"),
    scripts: resolve(root, "scripts"),
    data: resolve(root, "data"),
  };

  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Migrate: move session files to sessions/ if they're in root
  migrateFileIfNeeded(root, "sessions.json", dirs.sessions);
  migrateFileIfNeeded(root, "chat-settings.json", dirs.sessions);

  // Migrate: move stale files from root to files/
  migrateStaleFiles(root, dirs);

  return dirs;
}

function migrateFileIfNeeded(rootDir: string, filename: string, targetDir: string): void {
  const oldPath = resolve(rootDir, filename);
  const newPath = resolve(targetDir, filename);
  if (existsSync(oldPath) && !existsSync(newPath)) {
    try {
      renameSync(oldPath, newPath);
      log("workspace", `Migrated ${filename} to sessions/`);
    } catch {
      // Non-fatal
    }
  }
}

/** Calculate total disk usage of the workspace directory in bytes. */
export function getWorkspaceDiskUsage(root: string): number {
  let total = 0;
  function walk(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            total += statSync(full).size;
          } catch {
            // skip inaccessible files
          }
        }
      }
    } catch {
      // skip inaccessible dirs
    }
  }
  walk(root);
  return total;
}

const SYSTEM_DIRS = new Set(["memory", "logs", "uploads", "files", "sessions", "scripts", "data"]);
const SYSTEM_FILES = new Set([".user-session"]);

function migrateStaleFiles(rootDir: string, dirs: WorkspaceDirs): void {
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    let migrated = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && (SYSTEM_DIRS.has(entry.name) || entry.name.startsWith("."))) continue;
      if (entry.isDirectory()) continue; // Don't migrate unknown directories
      if (SYSTEM_FILES.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const ext = extname(entry.name).toLowerCase();
      const oldPath = join(rootDir, entry.name);

      // Route to appropriate directory
      let targetDir: string;
      if ([".py", ".js", ".ts", ".sh", ".bash", ".rb", ".go", ".rs"].includes(ext)) {
        targetDir = dirs.scripts;
      } else if ([".csv", ".json", ".xml", ".yaml", ".yml", ".sql", ".toml"].includes(ext)) {
        targetDir = dirs.data;
      } else {
        targetDir = dirs.files;
      }

      try {
        renameSync(oldPath, join(targetDir, entry.name));
        migrated++;
      } catch {
        // Non-fatal
      }
    }
    if (migrated > 0) {
      log("workspace", `Migrated ${migrated} file(s) from root to organized dirs`);
    }
  } catch {
    // Non-fatal
  }
}
