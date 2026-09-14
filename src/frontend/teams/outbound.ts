/**
 * Teams outbound — every card Talon sends is an Adaptive Card POSTed to the
 * Power Automate workflow webhook. There is no other send path.
 */

import { logError } from "../../util/log.js";
import { buildAdaptiveCard, splitTeamsMessage } from "./formatting.js";
import { proxyFetch } from "./proxy-fetch.js";
import type { TeamsRuntime } from "./runtime.js";

/** POST one card to the webhook; the caller decides what a non-2xx means. */
export function postCard(
  webhookUrl: string,
  card: Record<string, unknown>,
): Promise<Response> {
  return proxyFetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Split, card and POST a text; throws on the first chunk the webhook
 * rejects so tool callers see the failure.
 */
export async function postToTeams(
  webhookUrl: string,
  text: string,
): Promise<void> {
  const chunks = splitTeamsMessage(text);
  for (const chunk of chunks) {
    const resp = await postCard(webhookUrl, buildAdaptiveCard(chunk));
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Teams webhook POST failed: ${resp.status} ${body}`);
    }
  }
}

/**
 * Out-of-turn delivery (cron / pulse / heartbeat). Failures are logged and
 * swallowed — the callers have nowhere to surface them.
 */
export async function sendText(
  runtime: TeamsRuntime,
  text: string,
): Promise<void> {
  if (!text.trim()) return;
  try {
    const chunks = splitTeamsMessage(text);
    for (const chunk of chunks) {
      await postCard(runtime.webhookUrl, buildAdaptiveCard(chunk));
    }
  } catch (err) {
    logError(
      "teams",
      `sendMessage failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}
