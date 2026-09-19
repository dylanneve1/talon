-- Statements for the snapshot index (see repositories in
-- storage/backup/repo.ts for parameter order and row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO backups
  (id, kind, label, pinned, created_at, size_bytes, manifest_json)
VALUES (?, ?, ?, ?, ?, ?, ?)

-- name: get
SELECT id, kind, label, pinned, created_at, size_bytes, manifest_json
FROM backups WHERE id = ?

-- name: all
SELECT id, kind, label, pinned, created_at, size_bytes, manifest_json
FROM backups ORDER BY created_at DESC

-- name: ids
SELECT id FROM backups

-- name: setPinned
UPDATE backups SET pinned = ? WHERE id = ?

-- name: setManifest
UPDATE backups SET manifest_json = ?, pinned = ?, size_bytes = ? WHERE id = ?

-- name: remove
DELETE FROM backups WHERE id = ?

-- name: upsertRemote
INSERT OR REPLACE INTO backup_remotes
  (backup_id, target_id, status, remote_id, uploaded_at, error)
VALUES (?, ?, ?, ?, ?, ?)

-- name: remotesAll
SELECT backup_id, target_id, status, remote_id, uploaded_at, error
FROM backup_remotes

-- name: remotesFor
SELECT backup_id, target_id, status, remote_id, uploaded_at, error
FROM backup_remotes WHERE backup_id = ?

-- name: removeRemotes
DELETE FROM backup_remotes WHERE backup_id = ?

-- name: removeRemote
DELETE FROM backup_remotes WHERE backup_id = ? AND target_id = ?
