-- Statements for the goals table (see repositories/goals-repo.ts for
-- the parameter order and row↔domain mapping). The status-filtered
-- listings interpolate a placeholder list at the call site — see
-- expandStatusPlaceholders in goals-repo.ts.

-- name: upsert
INSERT OR REPLACE INTO goals
  (id, chat_id, title, description, status, priority, created_at,
   updated_at, due_at, last_progress_note, last_progress_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: get
SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals WHERE id = ?

-- name: listByChat
SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals WHERE chat_id = ? ORDER BY updated_at DESC

-- name: listByChatAndStatus
SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals
WHERE chat_id = ? AND status IN (/* statuses */)
ORDER BY updated_at DESC

-- name: listByStatus
SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals
WHERE status IN (/* statuses */)
ORDER BY updated_at DESC

-- name: countByChatAndStatus
SELECT COUNT(*) AS n FROM goals
WHERE chat_id = ? AND status IN (/* statuses */)

-- name: remove
DELETE FROM goals WHERE id = ?
