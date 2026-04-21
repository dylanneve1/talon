/**
 * End-of-turn reconciliation for a ResponseStream.
 *
 * One rule shared by every frontend: if a send_* tool delivered the answer
 * (bridgeMessageCount > 0), discard any leftover preview; otherwise, commit
 * whatever text the stream has buffered (trailing assistant text that wasn't
 * routed through a tool). This is what keeps the Teams/terminal/telegram
 * frontends consistent — no one-off "suppress fallback" branches.
 */

import type { ResponseStream } from "./types.js";

export async function finalizeTurn(
  stream: ResponseStream,
  bridgeMessageCount: number,
): Promise<void> {
  if (bridgeMessageCount > 0) {
    await stream.discard();
    return;
  }
  if (stream.hasPending()) {
    await stream.commit();
    return;
  }
  await stream.discard();
}
