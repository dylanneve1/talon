-- 3 — BLAKE3 content hash on media entries (native/blake3-wasm).
--
-- Filled in asynchronously after download by the media store; NULL
-- until hashed (or when hashing failed). The index backs the dedupe
-- lookup ("has this exact content been downloaded before?") and the
-- reference count that keeps the expiry sweep from unlinking a file
-- that deduped entries still share.
ALTER TABLE media_index ADD COLUMN content_hash TEXT;
CREATE INDEX idx_media_hash ON media_index(content_hash);
