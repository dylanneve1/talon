/**
 * Daemon PID file — records which process is the Talon daemon.
 *
 * The file lives at ~/.talon/talon.pid and holds a small JSON record
 * (`{ pid, port, startedAt }`). Legacy bare-integer files written by
 * older versions are still readable.
 *
 * Ownership rules:
 *   - The daemon itself is the only writer: it records its own pid at
 *     boot and adds the gateway port once the gateway has bound (the
 *     gateway may fall back to a different port on EADDRINUSE, so the
 *     port is only known at runtime).
 *   - Removal is guarded by pid. During a `/restart` handoff
 *     (util/respawn.ts) the successor overwrites the file with its own
 *     pid *before* the dying parent finishes its graceful shutdown — an
 *     unconditional unlink there would orphan the new daemon, making
 *     `talon stop`/`talon restart` report "not running" and spawn
 *     duplicates that fight over Telegram's getUpdates.
 */

import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import { files as pathFiles } from "../../util/paths.js";

export type PidRecord = {
  pid: number;
  /** Gateway HTTP port — present once the gateway has bound. */
  port?: number;
  /** ISO timestamp of daemon boot. */
  startedAt?: string;
};

export function readPidRecord(file: string = pathFiles.pid): PidRecord | null {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      // Legacy format: bare integer pid.
      const pid = parseInt(raw, 10);
      return pid > 0 ? { pid } : null;
    }
    const parsed = JSON.parse(raw) as Partial<PidRecord>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid as number) <= 0)
      return null;
    return {
      pid: parsed.pid as number,
      port: Number.isInteger(parsed.port) ? (parsed.port as number) : undefined,
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
    };
  } catch {
    return null; // unreadable or corrupt — treated as absent
  }
}

export function writePidRecord(
  record: PidRecord,
  file: string = pathFiles.pid,
): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic.sync(file, JSON.stringify(record) + "\n");
  } catch {
    /* best-effort — the daemon must not die over a pidfile */
  }
}

/**
 * Remove the pidfile only if it still belongs to `ownPid`. Returns
 * whether the file was removed. See the ownership rules above for why
 * an unconditional unlink is wrong.
 */
export function removePidRecordIfOwnedBy(
  ownPid: number,
  file: string = pathFiles.pid,
): boolean {
  const current = readPidRecord(file);
  if (!current || current.pid !== ownPid) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Signal-0 liveness probe — works on Linux, macOS, and Windows. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
