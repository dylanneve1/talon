/**
 * OpenCode session helpers — thin wrapper around
 * `backend/remote-server/session-helpers.ts`.
 *
 * Kilo is a fork of OpenCode that exposes the same session message shape
 * and question API, so the parsing / summarisation / snapshot logic
 * lives in the shared module. This file binds the OpenCode backend label
 * and re-exports under OpenCode-named symbols for back-compat with the
 * handler and the public OpenCode barrel.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  REMOTE_SESSION_MESSAGE_LIMIT,
  extractPartsSummary as extractPartsSummaryShared,
  extractAssistantUsage as extractAssistantUsageShared,
  summarizeAssistantMessages,
  getTurnSummary,
  getSessionSnapshot,
  rejectPendingQuestions as rejectPendingQuestionsShared,
  type RemoteAssistantInfo,
  type RemoteSessionSnapshot,
  type RemoteSessionClient,
} from "../remote-server/session-helpers.js";
import { ensureServer } from "./server.js";

// ── Constants / type aliases (OpenCode-named surface) ──────────────────────

export const OPENCODE_SESSION_MESSAGE_LIMIT = REMOTE_SESSION_MESSAGE_LIMIT;

/** Subset of OpenCode's `Message.info` used by Talon for usage accounting. */
export type OpenCodeAssistantInfo = RemoteAssistantInfo;

/** Snapshot of an OpenCode session's lifetime + last-turn assistant info. */
export type OpenCodeSessionSnapshot = RemoteSessionSnapshot;

// ── Re-exports of pure helpers ─────────────────────────────────────────────

export const extractPartsSummary = extractPartsSummaryShared;
export const extractAssistantUsage = extractAssistantUsageShared;

/**
 * Summarise a batch of session messages into per-turn usage totals.
 * Re-exported under the OpenCode-prefixed name for back-compat with
 * existing imports.
 */
export const summarizeOpenCodeAssistantMessages = summarizeAssistantMessages;

// ── Session-messages aggregators ──────────────────────────────────────────

/**
 * Aggregate the most recent turn's assistant messages into a usage
 * summary. Delegates to the shared helper with an OpenCode-typed client.
 */
export function getOpenCodeTurnSummary(
  oc: OpencodeClient,
  sessionId: string,
  minCreatedAt: number,
): Promise<ReturnType<typeof summarizeAssistantMessages>> {
  return getTurnSummary(
    oc as unknown as RemoteSessionClient,
    sessionId,
    minCreatedAt,
  );
}

/**
 * Build an {@link OpenCodeSessionSnapshot} for the given session id.
 *
 * Returns `undefined` if no session id was provided.
 */
export async function getOpenCodeSessionSnapshot(
  sessionId: string | undefined,
): Promise<OpenCodeSessionSnapshot | undefined> {
  if (!sessionId) return undefined;
  const oc = await ensureServer();
  return getSessionSnapshot(oc as unknown as RemoteSessionClient, sessionId);
}

// ── Pending-question guard ─────────────────────────────────────────────────

/**
 * Auto-respond to pending OpenCode questions for this session. Delegates
 * to the shared helper with the OpenCode backend label.
 */
export function rejectPendingQuestions(
  oc: OpencodeClient,
  sessionId: string,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<void> {
  return rejectPendingQuestionsShared(
    oc as unknown as RemoteSessionClient,
    sessionId,
    chatId,
    seenQuestionIds,
    "OpenCode",
  );
}
