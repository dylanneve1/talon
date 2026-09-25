/**
 * Dispatcher — execution path for all AI queries.
 *
 * Manages the public dispatcher entry points. The Weaver owns per-chat
 * serialization and the turn runner.
 *
 * Dependencies are injected at startup — this module imports nothing from
 * frontend/ or backend/.
 */

import type { ExecuteParams, ExecuteResult } from "../types.js";
import { formatRelayBlock, takePendingRelay } from "./cross-chat-relay.js";
import { recordMessageSignal } from "../memory/taps.js";
import { log } from "../../util/log.js";
import { taskTable, type KillOutcome } from "../tasks/index.js";
import { initWeaver, type Weaver, type WeaverDeps } from "../weaver/index.js";

// ── Dependencies (injected at startup) ──────────────────────────────────────

/**
 * `getBackend` takes the string chat id so it can route per-chat —
 * a chat with a backend override returns its override backend, others
 * fall through to the global chat-role backend. Tests can pass a
 * stub that ignores the chat id. See `core/engine/backend-controller/`.
 *
 * `resolveActiveModel` walks the 5-step active-model resolution
 * chain for the chat and returns both the resolved `ModelRef` and
 * the raw string + backend id. When `ref` and `model` are both
 * `null`, the dispatcher refuses to call the backend and replies
 * with a "use /model to pick one" message — submitting an empty
 * model id would either error opaquely or run on the wrong default.
 */
type DispatcherDeps = WeaverDeps;

let weaver: Weaver | null = null;

export function initDispatcher(d: DispatcherDeps): void {
  weaver = initWeaver(d);
  log("dispatcher", "Initialized (per-chat serial, cross-chat parallel)");
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Number of queries currently running. */
export function getActiveCount(): number {
  return weaver?.getActiveCount() ?? 0;
}

/**
 * Stop only this chat's active turn. A later message already waiting in the
 * per-chat FIFO is intentionally left alone and runs after the stop settles.
 */
export function stopCurrentTurn(chatId: string): KillOutcome {
  return taskTable.killRunningTurn(chatId);
}

/**
 * Request an abort of every chat's running turn. The shutdown drain calls
 * this before polling `getActiveCount` — a turn can legitimately run for
 * minutes, so a drain that only waits can never succeed against one.
 * Returns the number of kill requests issued.
 */
export function stopAllTurns(): number {
  return taskTable.killAllRunningTurns();
}

/**
 * Execute an AI query with full lifecycle management.
 * Same-chat queries are serialized (FIFO) to avoid session conflicts.
 * Different-chat queries run in true parallel.
 *
 * Every turn for every frontend and every source funnels through here,
 * which makes it the one place a cross-chat reply can be folded in
 * without teaching each frontend about the relay.
 *
 * It is also where the memory tap lives, for the same reason: a
 * directive is a directive whether it arrives over Telegram, Discord,
 * WhatsApp, Teams, the native bridge or the terminal, and the tap used
 * to see only one of them. Only `source: "message"` is tapped — a pulse,
 * a cron job or a trigger is Talon prompting itself, and "always reply
 * in one line" written by a scheduler is not standing human intent.
 */
export async function execute(params: ExecuteParams): Promise<ExecuteResult> {
  if (!weaver) throw new Error("Dispatcher not initialized");
  // Fire-and-forget: the tap is a synchronous store write that must not
  // be able to delay or fail the turn (it swallows its own errors).
  if (params.source === "message")
    recordMessageSignal({
      text: params.prompt,
      chatKey: params.chatId,
      ...(params.senderName ? { actor: params.senderName } : {}),
    });
  const relayed = takePendingRelay(params.chatId);
  const prompt = relayed.length
    ? formatRelayBlock(relayed) + params.prompt
    : params.prompt;
  return weaver.runTurn(relayed.length ? { ...params, prompt } : params);
}
