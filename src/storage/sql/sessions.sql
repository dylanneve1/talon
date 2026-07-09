-- Statements for the sessions table (see repositories/sessions-repo.ts
-- for the parameter order and row↔domain mapping).

-- name: upsert
INSERT OR REPLACE INTO sessions
  (chat_id, session_id, session_name, last_model, turns, last_active,
   created_at, last_bot_message_id, total_input_tokens, total_output_tokens,
   total_cache_read, total_cache_write, last_prompt_tokens, context_tokens,
   context_window, num_api_calls, estimated_cost_usd, total_response_ms,
   last_response_ms, fastest_response_ms, metrics)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

-- name: all
SELECT chat_id, session_id, session_name, last_model, turns, last_active,
       created_at, last_bot_message_id, total_input_tokens, total_output_tokens,
       total_cache_read, total_cache_write, last_prompt_tokens, context_tokens,
       context_window, num_api_calls, estimated_cost_usd, total_response_ms,
       last_response_ms, fastest_response_ms, metrics
FROM sessions

-- name: remove
DELETE FROM sessions WHERE chat_id = ?
