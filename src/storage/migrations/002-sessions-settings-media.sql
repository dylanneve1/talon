-- 2 — sessions, chat settings, media index (replacing the JSON stores).
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
-- (the legacy "id" string was `chatId:msgId`), so upserts dedupe
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
CREATE INDEX idx_media_time ON media_index(timestamp);
