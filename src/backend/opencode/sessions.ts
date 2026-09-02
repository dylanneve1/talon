/**
 * OpenCode session helpers — the shared `remote-server/session-helpers.ts`
 * bound to the OpenCode client, re-exported under OpenCode-named symbols
 * for the handler / index / test imports.
 */

import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  extractPartsSummary as extractPartsSummaryShared,
  summarizeAssistantMessages,
  getSessionSnapshot,
  type RemoteSessionSnapshot,
  type RemoteSessionClient,
} from "../remote-server/session-helpers.js";
import { ensureServer } from "./server.js";

/** Snapshot of an OpenCode session's lifetime + last-turn assistant info. */
export type OpenCodeSessionSnapshot = RemoteSessionSnapshot;

export const extractPartsSummary = extractPartsSummaryShared;

/** Summarise a batch of session messages into per-turn usage totals. */
export const summarizeOpenCodeAssistantMessages = summarizeAssistantMessages;

/**
 * Build an {@link OpenCodeSessionSnapshot} for the given session id.
 * Returns `undefined` if no session id was provided.
 */
export async function getOpenCodeSessionSnapshot(
  sessionId: string | undefined,
): Promise<OpenCodeSessionSnapshot | undefined> {
  if (!sessionId) return undefined;
  const oc: OpencodeClient = await ensureServer();
  return getSessionSnapshot(oc as unknown as RemoteSessionClient, sessionId);
}
