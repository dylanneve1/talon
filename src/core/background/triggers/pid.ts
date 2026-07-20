/**
 * PID-starttime probe — the /proc read shared by spawn (capture at fork)
 * and resume (compare after restart). Lives alone so neither module has
 * to import the other for it.
 */

import { readFileSync } from "node:fs";

/**
 * Read field 22 (start time in jiffies since boot) from /proc/<pid>/stat.
 * Returns undefined if /proc isn't available (non-Linux) or the read fails.
 *
 * Parsing note: the `comm` field (2nd) is wrapped in parens and may itself
 * contain ')' — the safe parse finds the LAST ')' and splits the rest on
 * space. After that split, index 19 corresponds to field 22.
 */
export function readPidStarttimeSync(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen < 0) return undefined;
    const tail = stat.slice(lastParen + 2).split(" ");
    const starttime = Number(tail[19]);
    return Number.isFinite(starttime) ? starttime : undefined;
  } catch {
    return undefined;
  }
}
