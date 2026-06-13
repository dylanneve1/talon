-- Statements for the scripts table (see repositories/scripts-repo.ts
-- for the parameter order and row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO scripts
  (id, name, description, language, script_path, created_at,
   updated_at, use_count, last_used_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: getByName
SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM scripts WHERE name = ?

-- name: all
SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM scripts
ORDER BY last_used_at DESC NULLS LAST, updated_at DESC

-- name: count
SELECT COUNT(*) AS n FROM scripts

-- name: recordUse
UPDATE scripts SET use_count = use_count + 1, last_used_at = ? WHERE name = ?

-- name: removeByName
DELETE FROM scripts WHERE name = ?
