/**
 * Hub proxy server — an in-process MCP server that forwards tools/list
 * and tools/call to a hub-managed child (see children.ts).
 *
 * One proxy per hub session; many sessions share one child. The child
 * is re-acquired through `getChild` on every request, so a child that
 * was idle-reaped or crashed respawns transparently mid-session —
 * clients never see the lifecycle, only (at worst) a slow first call.
 *
 * Tools-only by design: every MCP server Talon consumes (plugins,
 * brave) exposes tools, and the backends only wire tools. Resource /
 * prompt requests are not declared in capabilities, so well-behaved
 * clients won't send them.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ChildHandle } from "./children.js";

export function buildProxyServer(
  name: string,
  getChild: () => Promise<ChildHandle>,
): Server {
  const server = new Server(
    { name, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const child = await getChild();
    child.touch();
    return { tools: await child.listTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const child = await getChild();
    child.touch();
    return child.callTool(request.params.name, request.params.arguments ?? {});
  });

  return server;
}
