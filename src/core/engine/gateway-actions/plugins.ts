/**
 * `reload_plugins` — hot-reload plugins, rebuild the system prompt, and
 * hot-swap MCP servers on the active query so new tools are available
 * without restarting.
 */

import { log, logWarn } from "../../../util/log.js";
import type { SharedActionHandlers } from "./types.js";

export const pluginHandlers: SharedActionHandlers = {
  reload_plugins: async (body, chatId, backend) => {
    try {
      const { reloadPlugins, getPluginPromptAdditions } =
        await import("../../plugin/index.js");
      const { rebuildSystemPrompt } = await import("../../../util/config.js");
      const { clearSystemPromptSnapshots } =
        await import("../../../backend/shared/system-prompt.js");

      // reloadPlugins reads + validates config internally — no double read.
      // Frontends are derived from config if not explicitly provided.
      const { names, config: freshConfig } = await reloadPlugins();

      // Rebuild system prompt on the freshConfig, then update the backend's
      // live config reference so subsequent messages use the new prompt
      rebuildSystemPrompt(freshConfig, getPluginPromptAdditions());
      backend?.control?.updateSystemPrompt?.(freshConfig.systemPrompt);

      // Plugin prompt additions changed — drop per-session prompt
      // snapshots so every chat's next turn picks up the new prompt
      // (deliberate one-time cache re-write per live session).
      clearSystemPromptSnapshots();

      // Hot-swap MCP servers on the active query so new plugin tools
      // are available immediately (not just on the next message)
      let mcpInfo = "";
      if (backend?.tools?.refreshTools) {
        try {
          // Prefer body._chatId (string chat ID passed by frontends that use
          // non-numeric IDs, e.g. Teams/terminal) over the numeric context ID.
          const refreshChatId =
            typeof body._chatId === "string" && body._chatId.length > 0
              ? body._chatId
              : String(chatId);
          const result = await backend.tools.refreshTools(refreshChatId);
          if (result) {
            const parts: string[] = [];
            if (result.added.length > 0)
              parts.push(`added: ${result.added.join(", ")}`);
            if (result.removed.length > 0)
              parts.push(`removed: ${result.removed.join(", ")}`);
            const errorKeys = Object.keys(result.errors);
            if (errorKeys.length > 0)
              parts.push(
                `errors: ${errorKeys.map((k) => `${k}: ${result.errors[k]}`).join("; ")}`,
              );
            if (parts.length > 0)
              mcpInfo = `\nMCP servers updated: ${parts.join(" | ")}`;
          }
        } catch (err) {
          logWarn(
            "gateway",
            `MCP server refresh failed during reload: ${err instanceof Error ? err.message : err}`,
          );
          mcpInfo = `\nWarning: MCP server refresh failed: ${err instanceof Error ? err.message : err}`;
        }
      }

      log("gateway", `reload_plugins: ${names.length} plugins loaded`);
      return {
        ok: true,
        text:
          `Plugins reloaded successfully.\n` +
          `Loaded (${names.length}): ${names.length > 0 ? names.join(", ") : "(none)"}` +
          mcpInfo,
      };
    } catch (err) {
      return {
        ok: false,
        error: `Plugin reload failed: ${err instanceof Error ? err.message : err}`,
      };
    }
  },
};
