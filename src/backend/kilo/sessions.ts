/**
 * Kilo session helpers — the shared `remote-server/session-helpers.ts`
 * bound to the Kilo client, re-exported under Kilo-named symbols for the
 * handler / index / test imports.
 */

import type { KiloClient } from "@kilocode/sdk/v2";
import {
  extractPartsSummary as extractPartsSummaryShared,
  extractAssistantUsage as extractAssistantUsageShared,
  summarizeAssistantMessages,
  getSessionSnapshot,
  type RemoteSessionSnapshot,
  type RemoteSessionClient,
} from "../remote-server/session-helpers.js";
import { ensureServer } from "./server.js";

/** Snapshot of a Kilo session's lifetime + last-turn assistant info. */
export type KiloSessionSnapshot = RemoteSessionSnapshot;

export const extractPartsSummary = extractPartsSummaryShared;
export const extractAssistantUsage = extractAssistantUsageShared;

/** Summarise a batch of session messages into per-turn usage totals. */
export const summarizeKiloAssistantMessages = summarizeAssistantMessages;

/**
 * Build a {@link KiloSessionSnapshot} for the given session id.
 * Returns `undefined` if no session id was provided.
 */
export async function getKiloSessionSnapshot(
  sessionId: string | undefined,
): Promise<KiloSessionSnapshot | undefined> {
  if (!sessionId) return undefined;
  const oc: KiloClient = await ensureServer();
  return getSessionSnapshot(oc as unknown as RemoteSessionClient, sessionId);
}
