-- Statements for the whatsapp_messages table (see
-- repositories/whatsapp-messages-repo.ts for parameter order and mapping).

-- name: insert
INSERT OR IGNORE INTO whatsapp_messages
  (chat_id, msg_id, wa_id, remote_jid, from_me, participant, sender_name,
   text, timestamp, message_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: byMsgId
SELECT chat_id, msg_id, wa_id, remote_jid, from_me, participant, sender_name,
       text, timestamp, message_json
FROM whatsapp_messages WHERE msg_id = ? LIMIT 1

-- name: byWaId
-- Newest first: a WhatsApp id re-delivered on reconnect maps to the row
-- that already exists for it.
SELECT chat_id, msg_id, wa_id, remote_jid, from_me, participant, sender_name,
       text, timestamp, message_json
FROM whatsapp_messages WHERE wa_id = ? ORDER BY msg_id DESC LIMIT 1

-- name: maxMsgId
SELECT MAX(msg_id) AS max_id FROM whatsapp_messages

-- name: deleteOlderThan
DELETE FROM whatsapp_messages WHERE timestamp < ?

-- name: deleteAll
DELETE FROM whatsapp_messages
