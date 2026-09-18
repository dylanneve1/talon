-- Statements for the memory tables (see repositories/memory-repo.ts for
-- the parameter order and row↔domain mapping). "Live" everywhere means
-- superseded_by IS NULL AND dropped_at IS NULL: a row that has been
-- replaced or dropped stays in the table (stable ids, revertible
-- history) but is invisible to listings and search.
--
-- The optional filters bind the same value twice — `(? IS NULL OR
-- col = ?)` — so the statement text is constant and nothing is
-- interpolated into SQL at the call site.

-- name: insert
-- RETURNING id so the caller gets the new row id without a second
-- round trip through last_insert_rowid().
INSERT INTO memory
  (kind, subject, key, text, source_frontend, source_chat, source_actor,
   source_turn, trust, confidence, created_at, last_seen_at, hit_count,
   salience, pinned, superseded_by, dropped_at, content_hash)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
RETURNING id

-- name: get
SELECT id, kind, subject, key, text, source_frontend, source_chat,
       source_actor, source_turn, trust, confidence, created_at,
       last_seen_at, hit_count, salience, pinned, superseded_by,
       dropped_at, content_hash
FROM memory WHERE id = ?

-- name: list
SELECT id, kind, subject, key, text, source_frontend, source_chat,
       source_actor, source_turn, trust, confidence, created_at,
       last_seen_at, hit_count, salience, pinned, superseded_by,
       dropped_at, content_hash
FROM memory
WHERE (? IS NULL OR kind = ?)
  AND (? IS NULL OR subject = ?)
  AND (? = 1 OR superseded_by IS NULL)
  AND (? = 1 OR dropped_at IS NULL)
ORDER BY pinned DESC, salience DESC, last_seen_at DESC, id DESC
LIMIT ?

-- name: liveStateByKey
SELECT id, kind, subject, key, text, source_frontend, source_chat,
       source_actor, source_turn, trust, confidence, created_at,
       last_seen_at, hit_count, salience, pinned, superseded_by,
       dropped_at, content_hash
FROM memory
WHERE kind = 'state' AND key = ?
  AND superseded_by IS NULL AND dropped_at IS NULL
ORDER BY id DESC LIMIT 1

-- name: searchFts
-- The match param must already be a valid FTS5 expression
-- (see memory.ts ftsQuery). Live rows only, best match first.
SELECT m.id, m.kind, m.subject, m.key, m.text, m.source_frontend,
       m.source_chat, m.source_actor, m.source_turn, m.trust, m.confidence,
       m.created_at, m.last_seen_at, m.hit_count, m.salience, m.pinned,
       m.superseded_by, m.dropped_at, m.content_hash
FROM memory m JOIN memory_fts ON memory_fts.rowid = m.id
WHERE memory_fts MATCH ?
  AND m.superseded_by IS NULL AND m.dropped_at IS NULL
  AND (? IS NULL OR m.kind = ?)
ORDER BY bm25(memory_fts) LIMIT ?

-- name: similar
-- Near-duplicate candidates for a fresh assert: live rows of the same
-- kind + subject that match the new text, the new row itself excluded.
SELECT m.id, m.kind, m.subject, m.key, m.text, m.source_frontend,
       m.source_chat, m.source_actor, m.source_turn, m.trust, m.confidence,
       m.created_at, m.last_seen_at, m.hit_count, m.salience, m.pinned,
       m.superseded_by, m.dropped_at, m.content_hash
FROM memory m JOIN memory_fts ON memory_fts.rowid = m.id
WHERE memory_fts MATCH ?
  AND m.kind = ? AND m.subject = ? AND m.id <> ?
  AND m.superseded_by IS NULL AND m.dropped_at IS NULL
ORDER BY bm25(memory_fts) LIMIT ?

-- name: setSupersededBy
UPDATE memory SET superseded_by = ? WHERE id = ?

-- name: setDropped
UPDATE memory SET dropped_at = ? WHERE id = ?

-- name: setPinned
UPDATE memory SET pinned = ? WHERE id = ?

-- name: touch
UPDATE memory SET hit_count = hit_count + 1, last_seen_at = ? WHERE id = ?

-- name: insertHistory
INSERT INTO memory_history (memory_id, op, before_text, after_text, reason, at)
VALUES (?, ?, ?, ?, ?, ?)

-- name: historyFor
SELECT id, memory_id, op, before_text, after_text, reason, at
FROM memory_history WHERE memory_id = ? ORDER BY id
