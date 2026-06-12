// AUTO-GENERATED FILE — DO NOT EDIT.
// Source of truth: the .sql files in this directory.
// Regenerate with `npm run build:sql` (drift-guarded by sql-embed.test.ts).

/** Append-only migration list; cursor is `PRAGMA user_version` (db.ts). */
export const MIGRATIONS: readonly string[] = [
  // 001_history.sql
  `-- 1 — chat history with FTS5 full-text index over text + sender.

CREATE TABLE history_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id         TEXT    NOT NULL,
  msg_id          INTEGER NOT NULL,
  sender_id       INTEGER NOT NULL,
  sender_name     TEXT    NOT NULL,
  text            TEXT    NOT NULL,
  reply_to_msg_id INTEGER,
  timestamp       INTEGER NOT NULL,
  media_type      TEXT,
  sticker_file_id TEXT,
  file_path       TEXT
);
CREATE INDEX idx_history_chat ON history_messages(chat_id, id);
CREATE UNIQUE INDEX idx_history_chat_msg ON history_messages(chat_id, msg_id);
CREATE INDEX idx_history_chat_sender ON history_messages(chat_id, sender_id, id);

CREATE VIRTUAL TABLE history_fts USING fts5(
  text,
  sender_name,
  content='history_messages',
  content_rowid='id'
);
CREATE TRIGGER history_ai AFTER INSERT ON history_messages BEGIN
  INSERT INTO history_fts(rowid, text, sender_name)
  VALUES (new.id, new.text, new.sender_name);
END;
CREATE TRIGGER history_ad AFTER DELETE ON history_messages BEGIN
  INSERT INTO history_fts(history_fts, rowid, text, sender_name)
  VALUES ('delete', old.id, old.text, old.sender_name);
END;
CREATE TRIGGER history_au AFTER UPDATE OF text, sender_name ON history_messages BEGIN
  INSERT INTO history_fts(history_fts, rowid, text, sender_name)
  VALUES ('delete', old.id, old.text, old.sender_name);
  INSERT INTO history_fts(rowid, text, sender_name)
  VALUES (new.id, new.text, new.sender_name);
END;`,
  // 002_stores.sql
  `-- 2 — sessions, chat settings, media index (replacing the JSON stores).
--
-- sessions: real columns rather than a JSON blob. The store's hot
-- paths (recordUsage, incrementTurns, setSessionId) accumulate into
-- individual fields per turn, and the usage counters are numeric
-- accounting data — typed columns keep them queryable and make the
-- whole-row upsert cheap. fastest_response_ms is NULL when no timed
-- turn has been recorded yet (the domain value is Infinity, which
-- JSON could never store — the legacy file held null there too).
--
-- chat_settings: one JSON document per chat. The access pattern is
-- strictly whole-record get/set keyed by chat id (every setter
-- rewrites the chat's small settings object; no field is ever
-- queried independently in SQL — filters like getRegisteredPulseChats
-- run over the in-memory snapshot), so per-field columns would buy
-- nothing and would need a migration per new setting.
--
-- media_index: real columns. Lookups filter by chat, by chat+type,
-- order by timestamp, and the expiry sweep scans by timestamp alone —
-- each pattern gets an index. (chat_id, msg_id) is the natural key
-- (the legacy "id" string was \`chatId:msgId\`), so upserts dedupe
-- re-downloads of the same message in place.

CREATE TABLE sessions (
  chat_id             TEXT    PRIMARY KEY,
  session_id          TEXT,
  session_name        TEXT,
  last_model          TEXT,
  turns               INTEGER NOT NULL DEFAULT 0,
  last_active         INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL DEFAULT 0,
  last_bot_message_id INTEGER,
  total_input_tokens  INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cache_read    INTEGER NOT NULL DEFAULT 0,
  total_cache_write   INTEGER NOT NULL DEFAULT 0,
  last_prompt_tokens  INTEGER NOT NULL DEFAULT 0,
  context_tokens      INTEGER NOT NULL DEFAULT 0,
  context_window      INTEGER NOT NULL DEFAULT 0,
  num_api_calls       INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd  REAL    NOT NULL DEFAULT 0,
  total_response_ms   REAL    NOT NULL DEFAULT 0,
  last_response_ms    REAL    NOT NULL DEFAULT 0,
  fastest_response_ms REAL
);

CREATE TABLE chat_settings (
  chat_id  TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);

CREATE TABLE media_index (
  chat_id     TEXT    NOT NULL,
  msg_id      INTEGER NOT NULL,
  sender_name TEXT    NOT NULL,
  type        TEXT    NOT NULL,
  file_path   TEXT    NOT NULL,
  caption     TEXT,
  timestamp   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX idx_media_chat_time ON media_index(chat_id, timestamp DESC);
CREATE INDEX idx_media_chat_type_time ON media_index(chat_id, type, timestamp DESC);
CREATE INDEX idx_media_time ON media_index(timestamp);`,
];

export const chatSettingsSql = {
  upsert: `INSERT OR REPLACE INTO chat_settings (chat_id, settings) VALUES (?, ?)`,
  all: `SELECT chat_id, settings FROM chat_settings`,
  remove: `DELETE FROM chat_settings WHERE chat_id = ?`,
} as const;

export const dbSql = {
  walCheckpoint: `PRAGMA wal_checkpoint(TRUNCATE)`,
} as const;

export const historySql = {
  insert: `INSERT OR IGNORE INTO history_messages
  (chat_id, msg_id, sender_id, sender_name, text, reply_to_msg_id,
   timestamp, media_type, sticker_file_id, file_path)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  recent: `SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? ORDER BY id DESC LIMIT ?`,
  setFilePath: `UPDATE history_messages SET file_path = ? WHERE chat_id = ? AND msg_id = ?`,
  deleteChat: `DELETE FROM history_messages WHERE chat_id = ?`,
  searchFts: `-- The match param must already be a valid FTS5 expression
-- (see history.ts ftsQuery).
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ?
  AND id IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)
ORDER BY id DESC LIMIT ?`,
  bySenderName: `-- The fragment param is LIKE-escaped by the repository (backslash escape).
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? AND lower(sender_name) LIKE ? ESCAPE '\\'
ORDER BY id DESC LIMIT ?`,
  byMsgId: `SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? AND msg_id = ? ORDER BY id DESC LIMIT 1`,
  bySenderId: `SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT ?`,
  latestMsgId: `SELECT msg_id FROM history_messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1`,
  knownUsers: `SELECT sender_id,
       MAX(timestamp) AS last_seen,
       COUNT(*) AS message_count,
       (SELECT sender_name FROM history_messages i
        WHERE i.chat_id = o.chat_id AND i.sender_id = o.sender_id
        ORDER BY i.id DESC LIMIT 1) AS name
FROM history_messages o
WHERE chat_id = ?
GROUP BY sender_id
ORDER BY last_seen DESC`,
  statsByChat: `SELECT COUNT(*) AS total,
       COUNT(DISTINCT sender_id) AS users,
       COALESCE(MIN(timestamp), 0) AS oldest,
       COALESCE(MAX(timestamp), 0) AS newest
FROM history_messages WHERE chat_id = ?`,
  distinctChatCount: `SELECT COUNT(DISTINCT chat_id) AS chats FROM history_messages`,
} as const;

export const mediaIndexSql = {
  upsert: `INSERT OR REPLACE INTO media_index
  (chat_id, msg_id, sender_name, type, file_path, caption, timestamp)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
  recentByChat: `-- Ties on timestamp keep insertion order (rowid ASC) to match the
-- legacy stable sort.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp
FROM media_index
WHERE chat_id = ? ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
  byType: `SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp
FROM media_index
WHERE chat_id = ? AND type = ?
ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
  olderThan: `SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp
FROM media_index WHERE timestamp < ?`,
  deleteOlderThan: `DELETE FROM media_index WHERE timestamp < ?`,
} as const;

export const sessionsSql = {
  upsert: `INSERT OR REPLACE INTO sessions
  (chat_id, session_id, session_name, last_model, turns, last_active,
   created_at, last_bot_message_id, total_input_tokens, total_output_tokens,
   total_cache_read, total_cache_write, last_prompt_tokens, context_tokens,
   context_window, num_api_calls, estimated_cost_usd, total_response_ms,
   last_response_ms, fastest_response_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  all: `SELECT chat_id, session_id, session_name, last_model, turns, last_active,
       created_at, last_bot_message_id, total_input_tokens, total_output_tokens,
       total_cache_read, total_cache_write, last_prompt_tokens, context_tokens,
       context_window, num_api_calls, estimated_cost_usd, total_response_ms,
       last_response_ms, fastest_response_ms
FROM sessions`,
  remove: `DELETE FROM sessions WHERE chat_id = ?`,
} as const;
