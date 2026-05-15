/**
 * Kilo session helpers — thin wrapper around
 * `backend/remote-server/session-helpers.ts`.
 *
 * Kilo organises a session as an ordered list of `messages`, each with a
 * typed parts array (text / tool / reasoning / step-start / step-finish).
 * The wire format is identical to OpenCode (Kilo is a fork), so the
 * actual parsing, summarisation, snapshot construction, and question-
 * rejection logic lives in the shared module. This file binds the Kilo
 * backend label and re-exports under Kilo-named symbols for back-compat
 * with handler / index imports.
 */

import type { KiloClient } from "@kilocode/sdk/v2";
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

// ── Constants / type aliases (Kilo-named surface) ──────────────────────────

export const KILO_SESSION_MESSAGE_LIMIT = REMOTE_SESSION_MESSAGE_LIMIT;

/** Subset of Kilo's `Message.info` used by Talon for usage accounting. */
export type KiloAssistantInfo = RemoteAssistantInfo;

/** Snapshot of a Kilo session's lifetime + last-turn assistant info. */
export type KiloSessionSnapshot = RemoteSessionSnapshot;

// ── Re-exports of pure helpers ─────────────────────────────────────────────

export const extractPartsSummary = extractPartsSummaryShared;
export const extractAssistantUsage = extractAssistantUsageShared;

/**
 * Summarise a batch of session messages into per-turn usage totals.
 * Re-exported under the Kilo-prefixed name for back-compat with
 * existing imports.
 */
export const summarizeKiloAssistantMessages = summarizeAssistantMessages;

// ── Session-messages aggregators ──────────────────────────────────────────

/**
 * Aggregate the most recent turn's assistant messages into a usage
 * summary. Delegates to the shared helper with a Kilo-typed client.
 */
export function getKiloTurnSummary(
  oc: KiloClient,
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
 * Build a {@link KiloSessionSnapshot} for the given session id.
 *
 * Returns `undefined` if no session id was provided.
 */
export async function getKiloSessionSnapshot(
  sessionId: string | undefined,
): Promise<KiloSessionSnapshot | undefined> {
  if (!sessionId) return undefined;
  const oc = await ensureServer();
  return getSessionSnapshot(oc as unknown as RemoteSessionClient, sessionId);
}

// ── Pending-question guard ─────────────────────────────────────────────────

/**
 * Auto-respond to pending Kilo questions for this session. Delegates to
 * the shared helper with the Kilo backend label.
 */
export function rejectPendingQuestions(
  oc: KiloClient,
  sessionId: string,
  chatId: string,
  seenQuestionIds: Set<string>,
): Promise<void> {
  return rejectPendingQuestionsShared(
    oc as unknown as RemoteSessionClient,
    sessionId,
    chatId,
    seenQuestionIds,
    "Kilo",
  );
}
