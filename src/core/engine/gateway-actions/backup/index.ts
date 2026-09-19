/**
 * Backup actions — the agent tools and the companion app's read surface.
 *
 * Two vocabularies over one subsystem. `create_checkpoint`,
 * `list_checkpoints` and `backup_status` are the model's tools and answer
 * in prose; `backup.status`, `backup.now` and `backup.list` are the
 * companion app's and answer with structured fields beside the text.
 *
 * All of them are chat-free: a snapshot belongs to the daemon, not to a
 * conversation, so the heartbeat and background runs can take one too.
 *
 * There is no restore action. Restoring replaces memory, database and
 * identity underneath a running daemon — that is a decision for a human
 * at a CLI or behind a confirmation button, never a tool call.
 */

import {
  collectBackupStatus,
  formatBackupStatus,
  formatSnapshotList,
  listSnapshots,
  runBackup,
} from "../../../backup/index.js";
import { log } from "../../../../util/log.js";
import type { SharedActionHandlers } from "../types.js";

const DEFAULT_LIST_LIMIT = 20;

function limitOf(
  body: Record<string, unknown>,
  fallback = DEFAULT_LIST_LIMIT,
): number {
  const raw = Number(body.limit);
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 100) : fallback;
}

async function takeCheckpoint(
  label: string,
  pinned: boolean,
  trigger: string,
): Promise<ReturnType<SharedActionHandlers[string]>> {
  try {
    const manifest = await runBackup({
      kind: "checkpoint",
      label,
      pinned,
      trigger,
    });
    log("gateway", `create_checkpoint: ${manifest.id} "${label}"`);
    return {
      ok: true,
      id: manifest.id,
      text:
        `Checkpoint ${manifest.id} taken — "${label}"` +
        (pinned ? " (pinned, never pruned)" : "") +
        `\n${manifest.parts.length} part(s), ${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB.` +
        `\nRestore it with: talon backup restore ${manifest.id}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const backupHandlers: SharedActionHandlers = {
  create_checkpoint: async (body) => {
    const label = String(body.label ?? "").trim();
    if (!label)
      return { ok: false, error: "create_checkpoint: label is required" };
    return takeCheckpoint(label, body.pin === true, "tool");
  },

  list_checkpoints: async (body) => {
    const snapshots = await listSnapshots();
    if (snapshots.length === 0) {
      return {
        ok: true,
        text: "No snapshots yet. create_checkpoint takes one now.",
        snapshots: [],
      };
    }
    const limited = snapshots.slice(0, limitOf(body));
    return {
      ok: true,
      text: formatSnapshotList(limited, limited.length),
      snapshots: limited,
    };
  },

  backup_status: async () => {
    const status = await collectBackupStatus({ withTargets: false });
    return { ok: true, text: formatBackupStatus(status) };
  },

  "backup.status": async () => {
    const status = await collectBackupStatus();
    return { ok: true, text: formatBackupStatus(status), status };
  },

  "backup.list": async (body) => {
    const snapshots = (await listSnapshots()).slice(0, limitOf(body, 50));
    return { ok: true, text: formatSnapshotList(snapshots), snapshots };
  },

  "backup.now": async (body) => {
    const label = String(body.label ?? "").trim();
    if (label) return takeCheckpoint(label, body.pin === true, "manual");
    try {
      const manifest = await runBackup({ kind: "backup", trigger: "manual" });
      return {
        ok: true,
        id: manifest.id,
        text: `Snapshot ${manifest.id} taken (${(manifest.sizeBytes / 1024 / 1024).toFixed(1)} MB).`,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Backup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/** None of these need a chat — backups belong to the daemon. */
export const backupChatFreeActions: ReadonlySet<string> = new Set(
  Object.keys(backupHandlers),
);
