/**
 * Teams response stream — Adaptive Cards are immutable once posted, so
 * `update()` only buffers. `commit()` posts the card; `discard()` drops the
 * buffer. This is what stops the historical "Suppressed fallback text" drop:
 * if the model emitted text but didn't call send_message, finalizeTurn calls
 * commit() and the text reaches the user as an Adaptive Card.
 */

import type { ResponseStream } from "../../core/types.js";
import { buildAdaptiveCard, splitTeamsMessage } from "./formatting.js";
import { proxyFetch } from "./proxy-fetch.js";
import { logError } from "../../util/log.js";

export type CreateTeamsStreamParams = {
  webhookUrl: string;
};

export function createTeamsStream(
  params: CreateTeamsStreamParams,
): ResponseStream {
  const { webhookUrl } = params;
  let pending = "";
  let done = false;

  const post = async (text: string): Promise<void> => {
    for (const chunk of splitTeamsMessage(text)) {
      const card = buildAdaptiveCard(chunk);
      try {
        const resp = await proxyFetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(card),
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          logError(
            "teams",
            `stream commit failed: ${resp.status} ${body.slice(0, 200)}`,
          );
        }
      } catch (err) {
        logError(
          "teams",
          `stream commit error: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  };

  return {
    update(text: string) {
      if (done) return;
      pending = text;
    },
    async commit(text?: string) {
      if (done) return;
      const source = text ?? pending;
      pending = "";
      const trimmed = source.trim();
      if (!trimmed) return;
      await post(trimmed);
    },
    async discard() {
      if (done) return;
      done = true;
      pending = "";
    },
    hasPending() {
      return !done && pending.trim().length > 0;
    },
  };
}
