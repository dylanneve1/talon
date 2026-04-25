/**
 * Main message handler — entry point for user queries.
 *
 * Delegates the live SDK iteration to the per-chat session queue (which
 * keeps a single Query alive per chat and injects new messages mid-flight)
 * and layers on top of it the recovery semantics that were here before:
 * session expiry retry, context-overflow retry, and overloaded-model fallback.
 */

import { resetSession } from "../../storage/sessions.js";
import { getChatSettings, setChatModel } from "../../storage/chat-settings.js";
import { classify } from "../../core/errors.js";
import { getFallbackModel } from "../../core/models.js";
import { logWarn, logError } from "../../util/log.js";
import { incrementCounter } from "../../util/metrics.js";

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { QueryParams, QueryResult } from "../../core/types.js";
import {
  submitMessage,
  getActiveQuery as sessionGetActiveQuery,
  getQueuedCount,
} from "./session-queue.js";

// ── Re-exports for callers that use the live Query handle ───────────────────

/** Get the active SDK Query for a chat, if one is in-flight. */
export function getActiveQuery(chatId: string): Query | undefined {
  return sessionGetActiveQuery(chatId);
}

/** Number of in-flight + pending turns for a chat. */
export { getQueuedCount };

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleMessage(
  params: QueryParams,
  _retried = false,
): Promise<QueryResult> {
  try {
    return await submitMessage(params);
  } catch (err) {
    const classified = classify(err);
    incrementCounter(`errors.${classified.reason ?? "unknown"}`);

    // Session expired — reset and retry once
    if (classified.reason === "session_expired" && !_retried) {
      logWarn(
        "agent",
        `[${params.chatId}] Stale session, retrying with fresh session`,
      );
      resetSession(params.chatId);
      return handleMessage(params, true);
    }

    // Context length exceeded — safety net for edge cases where SDK
    // auto-compaction doesn't prevent overflow
    if (classified.reason === "context_length" && !_retried) {
      logWarn(
        "agent",
        `[${params.chatId}] Context length exceeded, resetting session and retrying`,
      );
      resetSession(params.chatId);
      return handleMessage(params, true);
    }

    // Model fallback: if overloaded/timeout, retry with the configured fallback
    if (!_retried && classified.retryable) {
      const activeModel =
        getChatSettings(params.chatId).model ?? "claude-opus-4-6";
      const fallback = getFallbackModel(activeModel);
      if (fallback) {
        logWarn(
          "agent",
          `[${params.chatId}] ${classified.reason}, falling back to ${fallback}`,
        );
        resetSession(params.chatId);
        const originalModel = getChatSettings(params.chatId).model;
        setChatModel(params.chatId, fallback);
        try {
          return await handleMessage(params, true);
        } finally {
          setChatModel(params.chatId, originalModel);
        }
      }
    }

    logError("agent", `[${params.chatId}] SDK error: ${classified.message}`);
    throw classified;
  }
}
