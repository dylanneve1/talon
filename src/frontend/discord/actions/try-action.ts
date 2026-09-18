/**
 * Run a Discord action with uniform error mapping: DiscordAPIError becomes a
 * clean ActionResult, anything else a labelled failure.
 */

import type { ActionResult } from "../../../core/types.js";
import { mapDiscordError } from "../errors.js";

/** Run a Discord action; convert DiscordAPIError into a clean ActionResult. */
export async function tryAction(
  context: string,
  fn: () => Promise<ActionResult>,
): Promise<ActionResult> {
  try {
    return await fn();
  } catch (err) {
    const mapped = mapDiscordError(err, context);
    if (mapped) return mapped;
    return {
      ok: false,
      error: `${context} failed: ${err instanceof Error ? err.message : err}`,
    };
  }
}
