/**
 * Workspace — Claude's home directory.
 * Talon only ensures the root exists. Claude organizes it however it wants.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
