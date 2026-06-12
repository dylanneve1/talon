-- 5 — agent-authored skills. Metadata rows only: the script body
-- lives on disk under ~/.talon/workspace/skills/ (mirroring the
-- trigger-store split) so the agent can also Read/Edit a skill as a
-- normal workspace file. Skills are global capabilities, not chat
-- data — no chat_id column. `name` is the lookup key the agent
-- uses; UNIQUE enforces one skill per name.
CREATE TABLE skills (
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
