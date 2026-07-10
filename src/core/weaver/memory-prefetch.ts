/**
 * Memory prefetch (Phase B) — optional pre-retrieval of palace memory
 * for live user messages, strictly fail-closed: a broken palace must
 * never block chat delivery. The result is dynamic turn context passed
 * through ChatRunParams; it never touches the frozen prompt.
 *
 * The #373 trust policy is enforced HERE, not just in adapters: whatever a
 * retriever returns is passed through `filterAutoInjectable` before it can
 * reach the prompt, so a buggy or future adapter cannot leak `user_claim` /
 * `group_chat` items into auto-injection.
 */

import type { RetrievedMemory } from "../agent-runtime/capabilities.js";
import type { MemoryRetriever } from "../memory/retrieval.js";
import { filterAutoInjectable } from "../memory/retrieval.js";
import { logDebug, logWarn } from "../../util/log.js";

export type PrefetchMemoryInput = {
  chatId: string;
  text: string;
  senderName: string;
  isGroup: boolean;
  /** Request id for log correlation. */
  reqId: string;
};

export async function prefetchMemory(
  retrieve: MemoryRetriever,
  input: PrefetchMemoryInput,
): Promise<RetrievedMemory | undefined> {
  try {
    const raw = await retrieve({
      runKind: "chat",
      chatId: input.chatId,
      text: input.text,
      senderName: input.senderName,
      isGroup: input.isGroup,
    });
    const retrieved = filterAutoInjectable(raw);
    const droppedCount =
      (raw?.items.length ?? 0) - (retrieved?.items.length ?? 0);
    if (droppedCount > 0) {
      logWarn(
        "dispatcher",
        `[${input.reqId}] memory pre-retrieval: dropped ${droppedCount} ` +
          `low-trust item(s) the retriever failed to filter (#373)`,
      );
    }
    if (retrieved) {
      logDebug(
        "dispatcher",
        `[${input.reqId}] memory pre-retrieval: ${retrieved.items.length} item(s), ` +
          `${retrieved.items.reduce((n, i) => n + i.text.length, 0)} chars`,
      );
    }
    return retrieved;
  } catch (err) {
    logWarn(
      "dispatcher",
      `[${input.reqId}] memory pre-retrieval failed (running turn without it): ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return undefined;
  }
}
