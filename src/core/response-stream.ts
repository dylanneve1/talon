/**
 * End-of-turn reconciliation for a ResponseStream.
 *
 * One rule shared by every frontend: if a send_* tool delivered the answer
 * (bridgeMessageCount > 0), discard any leftover preview; otherwise, commit
 * the explicit undelivered assistant block from the backend, or fall back to
 * whatever preview text the stream has buffered. This is what keeps the
 * Teams/terminal/telegram frontends consistent even when SDK partial events
 * are disabled.
 */

import type { ExecuteResult, ResponseStream } from "./types.js";

export async function finalizeTurn(
  stream: ResponseStream,
  result: Pick<ExecuteResult, "bridgeMessageCount" | "undeliveredText">,
): Promise<void> {
  if (result.bridgeMessageCount > 0) {
    await stream.discard();
    return;
  }
  if (result.undeliveredText?.trim()) {
    await stream.commit(result.undeliveredText);
    return;
  }
  if (stream.hasPending()) {
    await stream.commit();
    return;
  }
  await stream.discard();
}
