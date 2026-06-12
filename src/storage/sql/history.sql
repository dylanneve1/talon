-- Statements for the history tables (see repositories/history-repo.ts
-- for the parameter order and row↔domain mapping).

-- name: insert
INSERT OR IGNORE INTO history_messages
  (chat_id, msg_id, sender_id, sender_name, text, reply_to_msg_id,
   timestamp, media_type, sticker_file_id, file_path)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: recent
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? ORDER BY id DESC LIMIT ?

-- name: setFilePath
UPDATE history_messages SET file_path = ? WHERE chat_id = ? AND msg_id = ?

-- name: deleteChat
DELETE FROM history_messages WHERE chat_id = ?

-- name: searchFts
-- The match param must already be a valid FTS5 expression
-- (see history.ts ftsQuery).
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ?
  AND id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)
ORDER BY id DESC LIMIT ?

-- name: bySenderName
-- The fragment param is LIKE-escaped by the repository (backslash escape).
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? AND lower(sender_name) LIKE ? ESCAPE '\'
ORDER BY id DESC LIMIT ?

-- name: byMsgId
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? AND msg_id = ? ORDER BY id DESC LIMIT 1

-- name: bySenderId
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT ?

-- name: latestMsgId
SELECT msg_id FROM history_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1

-- name: knownUsers
SELECT sender_id,
       MAX(timestamp) AS last_seen,
       COUNT(*) AS message_count,
       (SELECT sender_name FROM history_messages i
        WHERE i.chat_id = o.chat_id AND i.sender_id = o.sender_id
        ORDER BY i.id DESC LIMIT 1) AS name
FROM history_messages o
WHERE chat_id = ?
GROUP BY sender_id
ORDER BY last_seen DESC

-- name: statsByChat
SELECT COUNT(*) AS total,
       COUNT(DISTINCT sender_id) AS users,
       COALESCE(MIN(timestamp), 0) AS oldest,
       COALESCE(MAX(timestamp), 0) AS newest
FROM history_messages WHERE chat_id = ?

-- name: distinctChatCount
SELECT COUNT(DISTINCT chat_id) AS chats FROM history_messages
