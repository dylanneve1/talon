-- Statements for the turn_meta table (see frontend/native/turn-meta.ts).

-- name: get
SELECT meta FROM turn_meta WHERE chat_id = ? AND msg_id = ?

-- name: upsert
INSERT OR REPLACE INTO turn_meta (chat_id, msg_id, meta) VALUES (?, ?, ?)

-- name: removeChat
DELETE FROM turn_meta WHERE chat_id = ?

-- Retention: keep only the newest N turns per chat, matching the
-- /history page ceiling. Message ids are numeric-ascending per chat,
-- compared as integers.

-- name: prune
DELETE FROM turn_meta
WHERE chat_id = ?1
  AND msg_id NOT IN (
    SELECT msg_id FROM turn_meta
    WHERE chat_id = ?1
    ORDER BY CAST(msg_id AS INTEGER) DESC
    LIMIT ?2
  )
