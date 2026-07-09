/**
 * Bridge utilities — shared by the unified MCP server.
 *
 * Extracted from the old per-backend tools.ts files so there's
 * exactly one copy of callBridge / textResult.
 */

import { Agent } from "undici";
import type { BridgeFunction } from "./types.js";

/** Default wall-clock budget for a bridge action. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Actions that can legitimately outlive the default budget. Device file
 * transfers are chunked with no size cap, so they get a very generous
 * ceiling; exec-style actions are bounded by their own 300s command cap
 * (+ margin). Native read/write/edit route to a device when a teleport is
 * engaged, so they inherit transfer-grade budgets too.
 */
const LONG_ACTION_TIMEOUTS_MS: Record<string, number> = {
  device_pull_file: 3_600_000,
  device_push_file: 3_600_000,
  device_read_file: 3_600_000,
  device_write_file: 3_600_000,
  native_read: 3_600_000,
  native_write: 3_600_000,
  native_edit: 3_600_000,
  device_exec: 330_000,
  native_bash: 330_000,
  native_glob: 330_000,
  native_search: 330_000,
};

/**
 * Dispatcher with undici's header/body watchdogs disabled. The default
 * dispatcher fails any request whose response headers take >300s — which
 * would kill a long chunked transfer regardless of our AbortSignal. The
 * deadline is governed ONLY by the per-action AbortSignal below, so a slow
 * action can run its full budget and still deliver its error/result.
 */
let longHaulAgent: Agent | undefined;
function dispatcher(): Agent {
  longHaulAgent ??= new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return longHaulAgent;
}

/**
 * Create a bridge caller bound to a default URL and chat.
 *
 * The default `chatId` is what the MCP subprocess was spawned with (the
 * TALON_CHAT_ID env). For session-bound calls (chat mode) that's the
 * active chat. For session-less calls (heartbeat / dream outbound), the
 * env chat is empty/sentinel and the model passes `chat_id` in tool
 * params — the bridge promotes that explicit value to `_chatId` so the
 * gateway routes to it, AND keeps `chat_id` in the body as a signal
 * that this is an explicit-routing request (the gateway uses that signal
 * to skip the active-context-required check it normally enforces).
 *
 * Failure contract: every failure mode THROWS with a message that names
 * the action and what went wrong. The MCP server layer converts a throw
 * into an `isError` tool result, so the model always gets told — a tool
 * call can time out, but it can never silently vanish.
 */
export function createBridge(
  bridgeUrl: string,
  chatId: string,
): BridgeFunction {
  return async (action, params) => {
    const explicitChatId =
      params &&
      typeof (params as Record<string, unknown>).chat_id !== "undefined"
        ? String((params as Record<string, unknown>).chat_id)
        : null;
    const effectiveChatId = explicitChatId ?? chatId;
    const timeoutMs = LONG_ACTION_TIMEOUTS_MS[action] ?? DEFAULT_TIMEOUT_MS;
    let resp: Response;
    try {
      resp = await fetch(`${bridgeUrl}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // chat_id stays in body when set — gateway uses its presence as the
        // "explicit routing" signal. _chatId is the routing key either way.
        body: JSON.stringify({ action, ...params, _chatId: effectiveChatId }),
        signal: AbortSignal.timeout(timeoutMs),
        // Node's fetch is undici underneath and accepts its dispatcher
        // extension; the DOM RequestInit type just doesn't know about it.
        dispatcher: dispatcher(),
      } as RequestInit & { dispatcher: Agent });
    } catch (err) {
      const cause = err as Error & { name?: string };
      if (cause.name === "TimeoutError" || cause.name === "AbortError") {
        throw new Error(
          `"${action}" did not complete within ${Math.round(timeoutMs / 1000)}s. ` +
            `The operation may still be running on the daemon — check its ` +
            `outcome (e.g. list the target directory) before retrying.`,
        );
      }
      throw new Error(
        `"${action}" could not reach the Talon gateway: ${cause.message}`,
      );
    }
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
  isError?: boolean;
} {
  const r = result as { ok?: boolean; text?: string; error?: string };
  return {
    content: [
      { type: "text" as const, text: r.text ?? JSON.stringify(result) },
    ],
    // Gateway results carry ok:false on failure — mark those as tool errors
    // so the model treats the message as a failure, not a success payload.
    ...(r && typeof r === "object" && r.ok === false ? { isError: true } : {}),
  };
}
