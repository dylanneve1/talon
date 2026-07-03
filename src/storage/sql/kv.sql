-- Statements for the kv table (see storage/kv.ts).

-- name: get
SELECT value FROM kv WHERE key = ?

-- name: set
INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at

-- name: remove
DELETE FROM kv WHERE key = ?
