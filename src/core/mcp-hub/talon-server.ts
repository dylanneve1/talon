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

export const VALID_TOOL_FRONTENDS: ReadonlySet<string> = new Set([
  "telegram",
  "teams",
  "terminal",
  "discord",
  "native",
]);

export type TalonServerOptions = {
  frontend: ToolFrontend;
  chatId: string;
  /** Gateway base URL, e.g. http://127.0.0.1:19876 */
  bridgeUrl: string;
  disabledTools?: readonly string[];
  disabledToolTags?: readonly string[];
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
  });
  if (excludeTags.length > 0 && !tools.some((t) => t.name === "end_turn")) {
    const endTurn = composeTools({ frontend: options.frontend }).find(
      (t) => t.name === "end_turn",
    );
    if (endTurn) tools.push(endTurn);
  }

  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema, async (params) =>
      textResult(await tool.execute(params, bridge)),
    );
  }

  return server;
}
