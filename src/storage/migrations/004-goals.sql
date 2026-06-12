-- 4 — persistent goals. Real columns: the hot reads are filtered
-- (per-chat listing for the goal tools, cross-chat active scan for
-- the heartbeat) and ordered by recency, so each gets an index.
-- Progress is a single rolling note + timestamp rather than a
-- journal table — the full history already lands in heartbeat /
-- chat logs; the store only needs "where did this goal get to last".
CREATE TABLE goals (
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
CREATE INDEX idx_goals_chat_status ON goals(chat_id, status, updated_at DESC);
CREATE INDEX idx_goals_status ON goals(status, updated_at DESC);
