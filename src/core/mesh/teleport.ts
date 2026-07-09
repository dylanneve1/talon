/**
 * Teleport state — the single "active node" the native tools route through.
 *
 * When a node is active, Talon's native shell/file tools (bash/read/write/
 * edit/glob/search) execute ON that companion device via the mesh exec/fs
 * channel instead of on the daemon host — Talon acts as if it were running
 * on the phone. `teleport_back` clears it and everything runs locally again.
 *
 * State is a tiny JSON sidecar under the Talon root so it survives restarts
 * and is shared across the process (the native gateway actions read it on
 * every call). Deliberately global, not per-chat: teleport is an operator
 * mode for the whole daemon, matching how Dylan drives a single bot.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { dirs } from "../../util/paths.js";
import { writePrivateJson } from "./persist.js";

export type TeleportState = {
  /** Target device id (as registered in the mesh). */
  deviceId: string;
  /** Human name for messages. */
  deviceName: string;
  /**
   * Working directory tracked across native `bash` calls so a teleported
   * session feels persistent (a `cd` in one command carries to the next).
   * Undefined until the first command resolves it.
   */
  cwd?: string;
  /** When the teleport was engaged (epoch ms). */
  since: number;
};

/** Resolved lazily so a test can point it at a tmp file via env. */
function stateFile(): string {
  return (
    process.env.TALON_TELEPORT_STATE_FILE ??
    resolve(dirs.root, "teleport-state.json")
  );
}

let cache: TeleportState | null | undefined;

/** The active teleport target, or null when operating locally. */
export async function getTeleport(): Promise<TeleportState | null> {
  if (cache !== undefined) return cache;
  try {
    const raw = await readFile(stateFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<TeleportState>;
    cache =
      parsed && typeof parsed.deviceId === "string" && parsed.deviceId
        ? {
            deviceId: parsed.deviceId,
            deviceName:
              typeof parsed.deviceName === "string" && parsed.deviceName
                ? parsed.deviceName
                : parsed.deviceId,
            ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
            since: typeof parsed.since === "number" ? parsed.since : Date.now(),
          }
        : null;
  } catch {
    cache = null;
  }
  return cache;
}

/** Engage teleport onto a device. */
export async function setTeleport(
  deviceId: string,
  deviceName: string,
): Promise<TeleportState> {
  const state: TeleportState = {
    deviceId,
    deviceName,
    since: Date.now(),
  };
  cache = state;
  await writePrivateJson(stateFile(), state);
  return state;
}

/** Persist an updated working directory for the active teleport. */
export async function setTeleportCwd(cwd: string): Promise<void> {
  const current = await getTeleport();
  if (!current) return;
  const next: TeleportState = { ...current, cwd };
  cache = next;
  await writePrivateJson(stateFile(), next);
}

/** Return to local operation. Returns the prior target (for the message). */
export async function clearTeleport(): Promise<TeleportState | null> {
  const prior = await getTeleport();
  cache = null;
  await writePrivateJson(stateFile(), null);
  return prior;
}

/** Test seam — drop the in-memory cache so the next read hits disk. */
export function resetTeleportCache(): void {
  cache = undefined;
}
