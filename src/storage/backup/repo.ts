/**
 * Snapshot-index repository — executes the statements in
 * sql/backups.sql against the `backups` and `backup_remotes` tables.
 * No SQL text lives here and none lives above: `storage/backup/index.ts`
 * holds the domain API, this module owns statement execution and the
 * row↔domain mapping.
 *
 * The manifest travels as an opaque JSON string. Storage sits below the
 * engine, so it must not know the shape core/backup gives it — it stores
 * the bytes and the few columns the listing surfaces sort and filter on.
 */

import { getDatabase } from "../db.js";
import { backupsSql } from "../sql/statements.generated.js";

/** One snapshot as the index holds it. */
export type BackupRecord = {
  id: string;
  kind: string;
  label?: string;
  pinned: boolean;
  /** Epoch ms. */
  createdAt: number;
  sizeBytes: number;
  /** The manifest.json body, verbatim. */
  manifestJson: string;
};

/** One target's state for one snapshot. */
export type BackupRemoteRecord = {
  backupId: string;
  targetId: string;
  status: string;
  remoteId?: string;
  uploadedAt?: number;
  error?: string;
};

type Row = {
  id: string;
  kind: string;
  label: string | null;
  pinned: number;
  created_at: number;
  size_bytes: number;
  manifest_json: string;
};

type RemoteRow = {
  backup_id: string;
  target_id: string;
  status: string;
  remote_id: string | null;
  uploaded_at: number | null;
  error: string | null;
};

function toRecord(row: Row): BackupRecord {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label ?? undefined,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    sizeBytes: row.size_bytes,
    manifestJson: row.manifest_json,
  };
}

function toRemote(row: RemoteRow): BackupRemoteRecord {
  return {
    backupId: row.backup_id,
    targetId: row.target_id,
    status: row.status,
    remoteId: row.remote_id ?? undefined,
    uploadedAt: row.uploaded_at ?? undefined,
    error: row.error ?? undefined,
  };
}

export function upsert(record: BackupRecord): void {
  getDatabase()
    .prepare(backupsSql.upsert)
    .run(
      record.id,
      record.kind,
      record.label ?? null,
      record.pinned ? 1 : 0,
      record.createdAt,
      record.sizeBytes,
      record.manifestJson,
    );
}

export function get(id: string): BackupRecord | undefined {
  const row = getDatabase().prepare(backupsSql.get).get(id) as Row | undefined;
  return row ? toRecord(row) : undefined;
}

/** Newest first. */
export function all(): BackupRecord[] {
  return (getDatabase().prepare(backupsSql.all).all() as Row[]).map(toRecord);
}

export function ids(): string[] {
  return (getDatabase().prepare(backupsSql.ids).all() as { id: string }[]).map(
    (row) => row.id,
  );
}

export function setPinned(id: string, pinned: boolean): boolean {
  const result = getDatabase()
    .prepare(backupsSql.setPinned)
    .run(pinned ? 1 : 0, id) as { changes?: number };
  return (result.changes ?? 0) > 0;
}

export function setManifest(
  id: string,
  manifestJson: string,
  pinned: boolean,
  sizeBytes: number,
): void {
  getDatabase()
    .prepare(backupsSql.setManifest)
    .run(manifestJson, pinned ? 1 : 0, sizeBytes, id);
}

export function remove(id: string): void {
  getDatabase().prepare(backupsSql.remove).run(id);
}

export function upsertRemote(record: BackupRemoteRecord): void {
  getDatabase()
    .prepare(backupsSql.upsertRemote)
    .run(
      record.backupId,
      record.targetId,
      record.status,
      record.remoteId ?? null,
      record.uploadedAt ?? null,
      record.error ?? null,
    );
}

export function remotesAll(): BackupRemoteRecord[] {
  return (
    getDatabase().prepare(backupsSql.remotesAll).all() as RemoteRow[]
  ).map(toRemote);
}

export function remotesFor(backupId: string): BackupRemoteRecord[] {
  return (
    getDatabase().prepare(backupsSql.remotesFor).all(backupId) as RemoteRow[]
  ).map(toRemote);
}

export function removeRemotes(backupId: string): void {
  getDatabase().prepare(backupsSql.removeRemotes).run(backupId);
}

export function removeRemote(backupId: string, targetId: string): void {
  getDatabase().prepare(backupsSql.removeRemote).run(backupId, targetId);
}
