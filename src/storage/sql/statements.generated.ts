// AUTO-GENERATED FILE — DO NOT EDIT.
// Source of truth: the .sql files in this directory.
// Regenerate with `npm run build:sql` (drift-guarded by sql-embed.test.ts).

/** The complete idempotent schema, ensured on every open (db.ts). */
export const SCHEMA = `-- The complete database schema, ensured on every open (db.ts).
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
-- column. \`name\` is the lookup key; UNIQUE enforces one per name.
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
);`;

export const chatSettingsSql = {
  upsert: `INSERT OR REPLACE INTO chat_settings (chat_id, settings) VALUES (?, ?)`,
  all: `SELECT chat_id, settings FROM chat_settings`,
  remove: `DELETE FROM chat_settings WHERE chat_id = ?`,
} as const;

export const cronSql = {
  upsert: `INSERT OR REPLACE INTO cron_jobs
  (id, chat_id, name, type, content, enabled, schedule, every_ms,
   timezone, model, provider, instructions, start_at, end_at, max_runs,
   catchup, created_at, last_run_at, run_count, last_status, last_error,
   last_duration_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  get: `SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms
FROM cron_jobs WHERE id = ?`,
  listByChat: `SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms
FROM cron_jobs WHERE chat_id = ? ORDER BY created_at`,
  listAll: `SELECT id, chat_id, name, type, content, enabled, schedule, every_ms,
       timezone, model, provider, instructions, start_at, end_at, max_runs,
       catchup, created_at, last_run_at, run_count, last_status, last_error,
       last_duration_ms
FROM cron_jobs ORDER BY created_at`,
  remove: `DELETE FROM cron_jobs WHERE id = ?`,
  count: `SELECT COUNT(*) AS n FROM cron_jobs`,
  removeAll: `DELETE FROM cron_jobs`,
} as const;

export const dbSql = {
  walCheckpoint: `PRAGMA wal_checkpoint(TRUNCATE)`,
  addMediaContentHashColumn: `-- Column reconciliation for databases that shipped before
-- content_hash existed: ALTER has no IF NOT EXISTS form, so db.ts
-- attempts this on every open and swallows "duplicate column name" /
-- "no such table" (fresh databases get the column via schema.sql).
ALTER TABLE media_index ADD COLUMN content_hash TEXT`,
} as const;

export const goalsSql = {
  upsert: `INSERT OR REPLACE INTO goals
  (id, chat_id, title, description, status, priority, created_at,
   updated_at, due_at, last_progress_note, last_progress_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  get: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals WHERE id = ?`,
  listByChat: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals WHERE chat_id = ? ORDER BY updated_at DESC`,
  listByChatAndStatus: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals
WHERE chat_id = ? AND status IN (/* statuses */)
ORDER BY updated_at DESC`,
  listByStatus: `SELECT id, chat_id, title, description, status, priority, created_at,
       updated_at, due_at, last_progress_note, last_progress_at
FROM goals
WHERE status IN (/* statuses */)
ORDER BY updated_at DESC`,
  countByChatAndStatus: `SELECT COUNT(*) AS n FROM goals
WHERE chat_id = ? AND status IN (/* statuses */)`,
  remove: `DELETE FROM goals WHERE id = ?`,
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
  recentBefore: `-- Scroll-back pagination: the window of messages strictly older than a
-- given msg_id, newest-first (the repository reverses to chronological).
SELECT msg_id, sender_id, sender_name, text, reply_to_msg_id,
       timestamp, media_type, sticker_file_id, file_path
FROM history_messages
WHERE chat_id = ? AND msg_id < ? ORDER BY id DESC LIMIT ?`,
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

export const kvSql = {
  get: `SELECT value FROM kv WHERE key = ?`,
  set: `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  remove: `DELETE FROM kv WHERE key = ?`,
} as const;

export const mediaIndexSql = {
  upsert: `INSERT OR REPLACE INTO media_index
  (chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  recentByChat: `-- Ties on timestamp keep insertion order (rowid ASC) to match the
-- legacy stable sort.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE chat_id = ? ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
  byType: `SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE chat_id = ? AND type = ?
ORDER BY timestamp DESC, rowid ASC LIMIT ?`,
  olderThan: `SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index WHERE timestamp < ?`,
  deleteOlderThan: `DELETE FROM media_index WHERE timestamp < ?`,
  setContentHash: `UPDATE media_index SET content_hash = ? WHERE chat_id = ? AND msg_id = ?`,
  setFilePath: `UPDATE media_index SET file_path = ? WHERE chat_id = ? AND msg_id = ?`,
  firstByContentHash: `-- Oldest entry with this content hash other than the given row — the
-- canonical copy a duplicate download is deduped against.
SELECT chat_id, msg_id, sender_name, type, file_path, caption, timestamp, content_hash
FROM media_index
WHERE content_hash = ? AND NOT (chat_id = ? AND msg_id = ?)
ORDER BY timestamp ASC, rowid ASC LIMIT 1`,
  countByFilePath: `SELECT COUNT(*) AS n FROM media_index WHERE file_path = ?`,
} as const;

export const scriptsSql = {
  upsert: `INSERT OR REPLACE INTO scripts
  (id, name, description, language, script_path, created_at,
   updated_at, use_count, last_used_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  getByName: `SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM scripts WHERE name = ?`,
  all: `SELECT id, name, description, language, script_path, created_at,
       updated_at, use_count, last_used_at
FROM scripts
ORDER BY last_used_at DESC NULLS LAST, updated_at DESC`,
  count: `SELECT COUNT(*) AS n FROM scripts`,
  recordUse: `UPDATE scripts SET use_count = use_count + 1, last_used_at = ? WHERE name = ?`,
  removeByName: `DELETE FROM scripts WHERE name = ?`,
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

export const triggersSql = {
  upsert: `INSERT OR REPLACE INTO triggers
  (id, chat_id, numeric_chat_id, name, language, script_path, log_path,
   description, status, created_at, started_at, ended_at, pid,
   pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
   last_fire_payload, last_error, persistent, model)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  get: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers WHERE id = ?`,
  getByName: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers WHERE chat_id = ? AND name = ? LIMIT 1`,
  listByChat: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers WHERE chat_id = ? ORDER BY created_at`,
  listAll: `SELECT id, chat_id, numeric_chat_id, name, language, script_path, log_path,
       description, status, created_at, started_at, ended_at, pid,
       pid_starttime, timeout_seconds, exit_code, fire_count, last_fire_at,
       last_fire_payload, last_error, persistent, model
FROM triggers ORDER BY created_at`,
  remove: `DELETE FROM triggers WHERE id = ?`,
  count: `SELECT COUNT(*) AS n FROM triggers`,
  removeAll: `DELETE FROM triggers

-- Restart recovery (see loadTriggers): a non-persistent trigger that was
-- alive when the previous process died is dead now — mark it terminated
-- so the bot gets a wake fire about what happened. COALESCE keeps any
-- endedAt/lastError a clean shutdown already recorded.`,
  terminateInterrupted: `UPDATE triggers
SET status = 'terminated',
    pid = NULL,
    ended_at = COALESCE(ended_at, ?),
    -- Literal must match RESTART_KILL_ERROR in storage/trigger-store.ts.
    last_error = COALESCE(last_error, 'Talon restarted while trigger was running')
WHERE status IN ('running', 'pending') AND persistent = 0

-- Persistent triggers park in 'pending' with their pid preserved so
-- resumeAfterRestart can probe for a surviving orphan before respawning.`,
  parkInterruptedPersistent: `UPDATE triggers
SET status = 'pending'
WHERE status IN ('running', 'pending') AND persistent = 1`,
} as const;

export const turnMetaSql = {
  get: `SELECT meta FROM turn_meta WHERE chat_id = ? AND msg_id = ?`,
  upsert: `INSERT OR REPLACE INTO turn_meta (chat_id, msg_id, meta) VALUES (?, ?, ?)`,
  removeChat: `DELETE FROM turn_meta WHERE chat_id = ?

-- Retention: keep only the newest N turns per chat, matching the
-- /history page ceiling. Message ids are numeric-ascending per chat,
-- compared as integers.`,
  prune: `DELETE FROM turn_meta
WHERE chat_id = ?1
  AND msg_id NOT IN (
    SELECT msg_id FROM turn_meta
    WHERE chat_id = ?1
    ORDER BY CAST(msg_id AS INTEGER) DESC
    LIMIT ?2
  )`,
} as const;
