/**
 * Action routing — try a gateway action through every loaded plugin in load
 * order; first non-null result wins. Per-plugin errors are caught and surfaced
 * as error results rather than cascading.
 *
 * `handlePluginActionIn` is the addressed form: the backup subsystem asks
 * each plugin in turn whether it is a remote target, and must then be able
 * to send the follow-up uploads to THAT plugin. First-non-null routing
 * cannot express "this one", and the wire protocol carries no plugin id —
 * so the addressing lives here, on the core side, and the plugin-facing
 * contract is unchanged.
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

/** Names of the loaded plugins that can answer gateway actions, in load order. */
export function pluginsWithActions(): string[] {
  return registry.all
    .filter(({ plugin }) => plugin.handleAction !== undefined)
    .map(({ plugin }) => plugin.name);
}

/**
 * Run an action against one named plugin. Returns null when no plugin by
 * that name is loaded or it does not recognise the action.
 */
export async function handlePluginActionIn(
  name: string,
  body: Record<string, unknown>,
  chatId: string,
): Promise<ActionResult | null> {
  const entry = registry.all.find(({ plugin }) => plugin.name === name);
  if (!entry?.plugin.handleAction) return null;
  try {
    return await entry.plugin.handleAction(body, chatId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logError("plugin", `${name} action error: ${detail}`);
    return { ok: false, error: `Plugin ${name}: ${detail}` };
  }
}
