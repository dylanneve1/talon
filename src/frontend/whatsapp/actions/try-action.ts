/**
 * Run a WhatsApp action, converting a throw into a structured failure.
 */

import { logError } from "../../../util/log.js";
import type { ActionResult } from "../../../core/types.js";

/**
 * Run an action, converting a throw into a structured failure. WhatsApp
 * errors arrive as Boom objects whose message is the useful part; the
 * model gets that text so it can adapt rather than retry blindly.
 */
export async function tryAction(
  label: string,
  fn: () => Promise<ActionResult>,
): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError("whatsapp", `${label} failed: ${msg}`);
    return { ok: false, error: `${label}: ${msg}` };
  }
}
