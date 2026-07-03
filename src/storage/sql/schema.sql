-- The complete database schema, ensured on every open (db.ts).
-- Every statement is idempotent (IF NOT EXISTS), so a fresh database
-- gets everything and an existing one gets only what it's missing.
-- Renaming or reshaping something that already shipped needs an
-- explicit upgrade path, not an edit here.

-- Chat history, with an FTS5 full-text index over text + sender.
CREATE TABLE IF NOT EXISTS history_messages (
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
CREATE INDEX IF NOT EXISTS idx_history_chat ON history_messages(chat_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_chat_msg ON history_messages(chat_id, msg_id);
CREATE INDEX IF NOT EXISTS idx_history_chat_sender ON history_messages(chat_id, sender_id, id);

CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  text,
  sender_name,
  content='history_messages',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history_messages BEGIN
  INSERT INTO history_fts(rowid, text, sender_name)
  VALUES (new.id, new.text, new.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history_messages BEGIN
  INSERT INTO history_fts(history_fts, rowid, text, sender_name)
  VALUES ('delete', old.id, old.text, old.sender_name);
END;
CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE OF text, sender_name ON history_messages BEGIN
  INSERT INTO history_fts(history_fts, rowid, text, sender_name)
  VALUES ('delete', old.id, old.text, old.sender_name);
  INSERT INTO history_fts(rowid, text, sender_name)
  VALUES (new.id, new.text, new.sender_name);
END;

-- Sessions: real columns rather than a JSON blob. The store's hot
-- paths (recordUsage, incrementTurns, setSessionId) accumulate into
-- individual fields per turn, and the usage counters are numeric
-- accounting data — typed columns keep them queryable and make the
-- whole-row upsert cheap. fastest_response_ms is NULL when no timed
-- turn has been recorded yet (the domain value is Infinity, which
-- JSON could never store — the legacy file held null there too).
CREATE TABLE IF NOT EXISTS sessions (
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

-- Chat settings: one JSON document per chat. The access pattern is
-- strictly whole-record get/set keyed by chat id (every setter
-- rewrites the chat's small settings object; no field is ever queried
-- independently in SQL), so per-field columns would buy nothing.
CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id  TEXT PRIMARY KEY,
  settings TEXT NOT NULL
);

-- Media index: lookups filter by chat, by chat+type, order by
-- timestamp, and the expiry sweep scans by timestamp alone — each
-- pattern gets an index. (chat_id, msg_id) is the natural key, so
-- upserts dedupe re-downloads of the same message in place.
CREATE TABLE IF NOT EXISTS media_index (
  chat_id      TEXT    NOT NULL,
  msg_id       INTEGER NOT NULL,
  sender_name  TEXT    NOT NULL,
  type         TEXT    NOT NULL,
  file_path    TEXT    NOT NULL,
  caption      TEXT,
  timestamp    INTEGER NOT NULL,
  -- BLAKE3 content hash (native/blake3-wasm), filled in asynchronously
  -- after download; NULL until hashed. Backs the dedupe lookup and the
  -- reference count that keeps the expiry sweep from unlinking a file
  -- that deduped entries still share. Databases that shipped before
  -- this column get it via the reconcile ALTER in db.ts (sql/db.sql).
  content_hash TEXT,
  PRIMARY KEY (chat_id, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_media_chat_time ON media_index(chat_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_media_chat_type_time ON media_index(chat_id, type, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_media_time ON media_index(timestamp);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media_index(content_hash);

-- Persistent goals: multi-turn objectives the agent commits to and
-- the heartbeat advances. Hot reads are filtered (per-chat listing
-- for the goal tools, cross-chat open scan for the heartbeat) and
-- ordered by recency, so each gets an index. Progress is a single
-- rolling note + timestamp rather than a journal table — the full
-- history already lands in heartbeat / chat logs.
CREATE TABLE IF NOT EXISTS goals (
  id                 TEXT    PRIMARY KEY,
  chat_id            TEXT    NOT NULL,
  title              TEXT    NOT NULL,
  description        TEXT,
  status             TEXT    NOT NULL DEFAULT 'active',
  priority           TEXT    NOT NULL DEFAULT 'normal',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  due_at             INTEGER,
  last_progress_note TEXT,
  last_progress_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_goals_chat_status ON goals(chat_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status, updated_at DESC);

-- Agent-authored scripts. Metadata rows only: the script body lives on
-- disk under ~/.talon/workspace/scripts/ (mirroring the trigger-store
-- split) so the agent can also Read/Edit a script as a normal workspace
-- file. Scripts are global capabilities, not chat data — no chat_id
-- column. `name` is the lookup key; UNIQUE enforces one per name.
CREATE TABLE IF NOT EXISTS scripts (
  id           TEXT    PRIMARY KEY,
  name         TEXT    NOT NULL UNIQUE,
  description  TEXT    NOT NULL,
  language     TEXT    NOT NULL,
  script_path  TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);

-- Cron jobs: scheduled messages/queries per chat. Typed columns for
-- every field — the scheduler scans all jobs each tick and the
-- frontends list per chat, so rows must be cheap to read whole. A job
-- carries EITHER schedule (cron expression) OR every_ms (fixed
-- interval), never both — enforced by the store validator, not DDL,
-- so a legacy import can surface the row for repair instead of
-- silently dropping it.
CREATE TABLE IF NOT EXISTS cron_jobs (
  id               TEXT    PRIMARY KEY,
  chat_id          TEXT    NOT NULL,
  name             TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  content          TEXT    NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  schedule         TEXT,
  every_ms         INTEGER,
  timezone         TEXT,
  model            TEXT,
  provider         TEXT,
  instructions     TEXT,
  start_at         INTEGER,
  end_at           INTEGER,
  max_runs         INTEGER,
  catchup          TEXT,
  created_at       INTEGER NOT NULL,
  last_run_at      INTEGER,
  run_count        INTEGER NOT NULL DEFAULT 0,
  last_status      TEXT,
  last_error       TEXT,
  last_duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cron_chat ON cron_jobs(chat_id);

-- Triggers: bot-authored watch scripts running as supervised
-- subprocesses. Script bodies + run logs stay on disk under
-- data/trigger-runs/ (same metadata/body split as scripts); this table
-- is the supervision state. Restart recovery flips interrupted rows in
-- place (see triggers-repo.ts), so status is a hot filter per chat.
CREATE TABLE IF NOT EXISTS triggers (
  id                TEXT    PRIMARY KEY,
  chat_id           TEXT    NOT NULL,
  numeric_chat_id   INTEGER NOT NULL,
  name              TEXT    NOT NULL,
  language          TEXT    NOT NULL,
  script_path       TEXT    NOT NULL,
  log_path          TEXT    NOT NULL,
  description       TEXT,
  status            TEXT    NOT NULL,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  pid               INTEGER,
  pid_starttime     INTEGER,
  timeout_seconds   INTEGER NOT NULL,
  exit_code         INTEGER,
  fire_count        INTEGER NOT NULL DEFAULT 0,
  last_fire_at      INTEGER,
  last_fire_payload TEXT,
  last_error        TEXT,
  persistent        INTEGER NOT NULL DEFAULT 0,
  model             TEXT
);
CREATE INDEX IF NOT EXISTS idx_triggers_chat ON triggers(chat_id, status);

-- Small singleton state (heartbeat/dream run state, learned model
-- incompatibilities): namespaced key → JSON document. The shapes are
-- tiny, unqueried, and owned by their modules — a typed table per
-- blob would be schema churn for nothing. See storage/kv.ts.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Native-frontend turn metadata (tool calls, duration, token usage)
-- keyed by chat + message id, so the companion app's tool timeline
-- survives a history reload or daemon restart. Presentation metadata
-- with a per-chat retention window — one JSON document per turn, same
-- rationale as chat_settings.
CREATE TABLE IF NOT EXISTS turn_meta (
  chat_id TEXT NOT NULL,
  msg_id  TEXT NOT NULL,
  meta    TEXT NOT NULL,
  PRIMARY KEY (chat_id, msg_id)
);
