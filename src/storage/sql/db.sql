-- Statements shared by every store.

-- name: walCheckpoint
PRAGMA wal_checkpoint(TRUNCATE)

-- name: addMediaContentHashColumn
-- Column reconciliation for databases that shipped before
-- content_hash existed: ALTER has no IF NOT EXISTS form, so db.ts
-- attempts this on every open and swallows "duplicate column name" /
-- "no such table" (fresh databases get the column via schema.sql).
ALTER TABLE media_index ADD COLUMN content_hash TEXT
