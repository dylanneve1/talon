-- Statements for the media_index table (see
-- repositories/media-index-repo.ts for the parameter order and
-- row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO media_index
  (chat_id, msg_id, sender_name, type, file_path, caption, timestamp)
VALUES (?, ?, ?, ?, ?, ?, ?)

-- name: recentByChat
-- Ties on timestamp keep insertion order (rowid ASC) to match the
-- legacy stable sort.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp
FROM media_index
WHERE chat_id = ? ORDER BY timestamp DESC, rowid ASC LIMIT ?

-- name: byType
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp
FROM media_index
WHERE chat_id = ? AND type = ?
ORDER BY timestamp DESC, rowid ASC LIMIT ?

-- name: olderThan
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp
FROM media_index WHERE timestamp < ?

-- name: deleteOlderThan
DELETE FROM media_index WHERE timestamp < ?
