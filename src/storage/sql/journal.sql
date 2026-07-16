-- Statements for the event journal (see storage/journal.ts).

-- name: append
INSERT INTO journal (at, type, payload) VALUES (?, ?, ?)

-- name: recent
SELECT seq, at, type, payload FROM journal ORDER BY seq DESC LIMIT ?

-- name: recentByType
SELECT seq, at, type, payload FROM journal WHERE type = ? ORDER BY seq DESC LIMIT ?

-- name: prune
DELETE FROM journal WHERE seq NOT IN (SELECT seq FROM journal ORDER BY seq DESC LIMIT ?)

-- name: count
SELECT COUNT(*) AS n FROM journal
