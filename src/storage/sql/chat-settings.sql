-- Statements for the chat_settings table (see
-- repositories/chat-settings-repo.ts).

-- name: upsert
INSERT OR REPLACE INTO chat_settings (chat_id, settings) VALUES (?, ?)

-- name: all
SELECT chat_id, settings FROM chat_settings

-- name: remove
DELETE FROM chat_settings WHERE chat_id = ?
