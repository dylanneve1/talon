/**
 * Action routing — try a gateway action through every loaded plugin in load
 * order; first non-null result wins. Per-plugin errors are caught and surfaced
 * as error results rather than cascading.
 */

import { logError } from "../../util/log.js";
import type { ActionResult } from "../types.js";
import { registry } from "./registry.js";

export async function handlePluginAction(
  body: Record<string, unknown>,
  chatId: string,
): Promise<ActionResult | null> {
  for (const { plugin } of registry.all) {
    if (!plugin.handleAction) continue;
    try {
      const result = await plugin.handleAction(body, chatId);
      if (result) return result;
    } catch (err) {
      logError(
        "plugin",
        `${plugin.name} action error: ${err instanceof Error ? err.message : err}`,
      );
      return {
        ok: false,
        error: `Plugin ${plugin.name}: ${err instanceof Error ? err.message : err}`,
      };
    }
  }
  return null;
}
