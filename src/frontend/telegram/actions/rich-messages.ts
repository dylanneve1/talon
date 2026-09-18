/**
 * Rich Messages capability probe — whether native Rich Markdown delivery is
 * worth attempting on this Bot API server, latched off on the first
 * "method not found".
 */

import { logWarn } from "../../../util/log.js";

/**
 * Rich Messages arrived in Bot API 10.2. A self-hosted Bot API server (or a
 * deployment pinned to an older release) rejects `sendRichMessage` outright,
 * and retrying it per message would cost a doomed round-trip plus a warning
 * line on every single send. Probe once and latch, mirroring the
 * `draftsSupported` capability probe in `handlers/delivery.ts`.
 */
let richMessagesSupported = true;

/** Telegram's shape for "this build doesn't have that method". */
const METHOD_UNAVAILABLE_RE =
  /method not found|not supported|unknown method|unsupported method/i;

/** True while native Rich Markdown delivery is still worth attempting. */
export function richMessagesAvailable(): boolean {
  return richMessagesSupported;
}

/**
 * Log a failed Rich Message call and latch the capability off when the failure
 * says the method itself is missing. Payload-level rejections (a markdown
 * string Telegram won't parse) stay one-off — the next message may be fine.
 */
export function noteRichMessageFailure(err: unknown, context: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (METHOD_UNAVAILABLE_RE.test(msg)) {
    richMessagesSupported = false;
    logWarn(
      "bot",
      `Rich Messages unavailable on this Bot API server — using legacy HTML from now on (${context}): ${msg}`,
    );
    return;
  }
  logWarn(
    "bot",
    `Rich Markdown failed; falling back to HTML (${context}): ${msg}`,
  );
}

/** Test seam: re-arm the capability probe between cases. */
export function resetRichMessageSupport(): void {
  richMessagesSupported = true;
}
