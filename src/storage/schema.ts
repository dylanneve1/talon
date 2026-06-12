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
];
