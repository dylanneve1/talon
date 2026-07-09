-- Statements shared by every store.

-- name: walCheckpoint
PRAGMA wal_checkpoint(TRUNCATE)

-- name: addMediaContentHashColumn
-- Column reconciliation for databases that shipped before
-- content_hash existed: ALTER has no IF NOT EXISTS form, so db.ts
-- attempts this on every open and swallows "duplicate column name" /
-- "no such table" (fresh databases get the column via schema.sql).
ALTER TABLE media_index ADD COLUMN content_hash TEXT

-- name: addSessionsMetricsColumn
-- Column reconciliation for databases that shipped before per-session
-- metrics existed. Fresh databases get the column via schema.sql.
ALTER TABLE sessions ADD COLUMN metrics TEXT NOT NULL DEFAULT '{"lifetime":{"counters":{"queries":0,"toolCalls":0,"turnsWithTools":0,"apiCalls":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"failedTurns":0,"flowViolationRetries":0,"flowViolationCapExhausted":0,"trailingTextDropped":0},"latency":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsByName":{},"backend":{},"cacheHitPercent":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"toolCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0},"apiCallsPerTurn":{"count":0,"sumMs":0,"minMs":null,"maxMs":0}},"buckets":{}}'
