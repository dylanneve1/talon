-- Statements for the skills table (see repositories/skills-repo.ts
-- for the parameter order and row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO skills
  (id, name, description, language, script_path, created_at,
   updated_at, use_count, last_used_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: getByName
SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM skills WHERE name = ?

-- name: all
SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM skills
ORDER BY last_used_at DESC NULLS LAST, updated_at DESC

-- name: count
SELECT COUNT(*) AS n FROM skills

-- name: recordUse
UPDATE skills SET use_count = use_count + 1, last_used_at = ? WHERE name = ?

-- name: removeByName
DELETE FROM skills WHERE name = ?
