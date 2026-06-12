/**
 * Database schema — every piece of DDL in the codebase lives here.
 *
 * Append-only migration list; the cursor is SQLite's
 * `PRAGMA user_version` (see db.ts). Never edit or reorder a shipped
 * migration — add a new one.
 *
 * SQL strings are embedded (not .sql files on disk) deliberately:
 * compiled single-binary builds (`bun build --compile`) have no source
 * tree at runtime, and the schema must travel inside the bundle.
 */

export const MIGRATIONS: readonly string[] = [
  // 1 — chat history with FTS5 full-text index over text + sender.
  `
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
  END;
  `,

  // 2 — sessions, chat settings, media index (replacing the JSON stores).
  //
  // sessions: real columns rather than a JSON blob. The store's hot
  // paths (recordUsage, incrementTurns, setSessionId) accumulate into
  // individual fields per turn, and the usage counters are numeric
  // accounting data — typed columns keep them queryable and make the
  // whole-row upsert cheap. fastest_response_ms is NULL when no timed
  // turn has been recorded yet (the domain value is Infinity, which
  // JSON could never store — the legacy file held null there too).
  //
  // chat_settings: one JSON document per chat. The access pattern is
  // strictly whole-record get/set keyed by chat id (every setter
  // rewrites the chat's small settings object; no field is ever
  // queried independently in SQL — filters like getRegisteredPulseChats
  // run over the in-memory snapshot), so per-field columns would buy
  // nothing and would need a migration per new setting.
  //
  // media_index: real columns. Lookups filter by chat, by chat+type,
  // order by timestamp, and the expiry sweep scans by timestamp alone —
  // each pattern gets an index. (chat_id, msg_id) is the natural key
  // (the legacy "id" string was `chatId:msgId`), so upserts dedupe
  // re-downloads of the same message in place.
  `
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
  `,

  // 3 — BLAKE3 content hash on media entries (native/blake3-wasm).
  //
  // Filled in asynchronously after download by the media store; NULL
  // until hashed (or when hashing failed). The index backs the dedupe
  // lookup ("has this exact content been downloaded before?") and the
  // reference count that keeps the expiry sweep from unlinking a file
  // that deduped entries still share.
  `
  ALTER TABLE media_index ADD COLUMN content_hash TEXT;
  CREATE INDEX idx_media_hash ON media_index(content_hash);
  `,
];
