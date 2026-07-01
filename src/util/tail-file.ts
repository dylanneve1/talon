/**
 * Read the last lines of a file without loading the whole thing —
 * used by the frontends' `/admin logs` command to tail the log file.
 */

import { statSync, openSync, readSync, closeSync } from "node:fs";

/**
 * Return the last `maxLines` lines from the trailing `maxBytes` window of
 * `path`. Throws on I/O errors (missing file, permissions) — callers own
 * the user-facing fallback message.
 */
export function tailFile(path: string, maxLines = 20, maxBytes = 8192): string {
  const stat = statSync(path);
  const size = Math.min(maxBytes, stat.size);
  const buf = Buffer.alloc(size);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
  } finally {
    closeSync(fd);
  }
  return buf.toString("utf-8").trim().split("\n").slice(-maxLines).join("\n");
}
