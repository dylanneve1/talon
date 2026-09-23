/**
 * In-process Talon tool server — the hub-side twin of
 * `core/tools/mcp-server.ts`.
 *
 * Same composition (composeTools + createBridge + textResult), but
 * instead of reading `TALON_CHAT_ID`/`TALON_FRONTEND` from the env of a
 * dedicated subprocess, the binding arrives per hub session from the
 * request URL. One `McpServer` instance per session, zero processes —
 * this replaces the two processes (supervisor + server) that every
 * chat previously paid per configured frontend.
 *
 * Tool-surface trimming (`disabledTools` / `disabledToolTags`) applies
 * exactly as in the subprocess version, including the `end_turn`
 * exemption — tool-only backends need it to close every turn.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { composeTools } from "../tools/index.js";
import { createBridge, textResult } from "../tools/bridge.js";
import type { ToolFrontend, ToolTag } from "../tools/types.js";
import { guestParamViolation, isGuestToolAllowed } from "./guest-scope.js";

export const VALID_TOOL_FRONTENDS: ReadonlySet<string> = new Set([
  "telegram",
  "teams",
  "terminal",
  "discord",
  "native",
  "whatsapp",
]);

export type TalonServerOptions = {
  frontend: ToolFrontend;
  chatId: string;
  /** Gateway base URL, e.g. http://127.0.0.1:19876 */
  bridgeUrl: string;
  disabledTools?: readonly string[];
  disabledToolTags?: readonly string[];
  /** Expose the native tool set (replaces the SDK built-ins). */
  includeNativeTools?: boolean;
  /**
   * Guest DM: expose only the conversation allowlist and refuse calls that
   * name another chat or a local file. See guest-scope.ts.
   */
  guest?: boolean;
};

/** Build a Talon tool MCP server bound to one (frontend, chatId) pair. */
export function buildTalonToolServer(options: TalonServerOptions): McpServer {
  const bridge = createBridge(options.bridgeUrl, options.chatId);
  const server = new McpServer({
    name: `${options.frontend}-tools`,
    version: "3.0.0",
  });

  const excludeNames = (options.disabledTools ?? []).filter(
    (name) => name !== "end_turn",
  );
  const excludeTags = (options.disabledToolTags ?? []) as ToolTag[];

  const tools = composeTools({
    frontend: options.frontend,
    excludeTags,
    excludeNames,
    includeNativeTools: options.includeNativeTools,
  });
  if (excludeTags.length > 0 && !tools.some((t) => t.name === "end_turn")) {
    const endTurn = composeTools({ frontend: options.frontend }).find(
      (t) => t.name === "end_turn",
    );
    if (endTurn) tools.push(endTurn);
  }

  const surface = options.guest
    ? tools.filter((t) => isGuestToolAllowed(t.name))
    : tools;

  for (const tool of surface) {
    server.tool(tool.name, tool.description, tool.schema, async (params) => {
      if (options.guest) {
        const why = guestParamViolation(
          options.chatId,
          params as Record<string, unknown>,
        );
        if (why) return textResult(`Not available in this chat: ${why}.`);
      }
      return textResult(await tool.execute(params, bridge));
    });
  }

  return server;
}
