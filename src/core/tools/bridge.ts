/**
 * Bridge utilities — shared by the unified MCP server.
 *
 * Extracted from the old per-backend tools.ts files so there's
 * exactly one copy of callBridge / textResult.
 */

import type { BridgeFunction } from "./types.js";

/** Create a bridge caller bound to a specific URL and chat. */
export function createBridge(
  bridgeUrl: string,
  chatId: string,
): BridgeFunction {
  return async (action, params) => {
    const resp = await fetch(`${bridgeUrl}/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...params, _chatId: chatId }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Bridge error (${resp.status}): ${text}`);
    }
    return resp.json();
  };
}

/** Wrap a bridge result into the MCP content format. */
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
