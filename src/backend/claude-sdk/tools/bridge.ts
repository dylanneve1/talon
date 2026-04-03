/**
 * Bridge utilities — shared infrastructure for all tool modules.
 * Communicates with the main bot process via HTTP bridge.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export { z };

const BRIDGE_URL = process.env.TALON_BRIDGE_URL || "http://127.0.0.1:19876";
const CHAT_ID = process.env.TALON_CHAT_ID || "";

export async function callBridge(
  action: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const resp = await fetch(`${BRIDGE_URL}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Include chatId so bridge can verify it matches the active context
    body: JSON.stringify({ action, _chatId: CHAT_ID, ...params }),
    signal: AbortSignal.timeout(120_000), // 2-minute timeout prevents hanging
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bridge error (${resp.status}): ${text}`);
  }
  return resp.json();
}

export function textResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const r = result as { text?: string; error?: string };
  return {
    content: [
      { type: "text" as const, text: r.text ?? JSON.stringify(result) },
    ],
  };
}

export type ToolServer = McpServer;
